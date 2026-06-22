// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A minimal built-in identd (RFC 1413). When a multi-user Lurker connects many
// users to a network from one IP, the network can't tell them apart unless an
// identd vouches for each connection's ident. This server answers the IRC
// server's port-113 callback by mapping the connection's *local source port* to
// the ident Lurker registered for it (see ircConnection.ts).
//
// Opt-in via LURKER_IDENTD_ENABLED — binding :113 is privileged and most
// single-user self-hosts don't need it; the hosted (node) edition turns it on
// per cell. Mirrors The Lounge's built-in identd: to avoid running as root you
// can set LURKER_IDENTD_PORT to a high port and have the host's oidentd forward
// to it (:113 must be reachable by the IRC server either way).

import net from 'net';

// One registered outbound IRC connection's identity. Keyed by a unique id, NOT
// the local port: two simultaneous connections may legally share a local source
// port (TCP only requires the full 4-tuple to be unique), so keying on the port
// alone lets one clobber the other's ident — and closing one would delete the
// other's still-live mapping. Module-scoped so the connection layer and the
// server share one map.
interface IdentEntry {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  ident: string;
}

const idents = new Map<number, IdentEntry>();
let nextIdentId = 0;

// ---------------------------------------------------------------------------
// Outcome metrics
// ---------------------------------------------------------------------------

// The residual ident failures are otherwise invisible: when a query matched no
// live 4-tuple the old code answered NO-USER and logged nothing, so there was no
// way to tell a registration race (the query beat our own connect callback
// through the event loop) from a connection that never reached us. These
// counters — surfaced in `docker logs` by the periodic summary in startIdentd —
// make the served / rescued / missed split greppable in prod.
interface IdentdMetrics {
  accepted: number; // inbound :113 connections accepted
  queries: number; // well-formed query lines parsed
  served: number; // answered USERID on the first lookup
  rescued: number; // answered USERID only after waiting out the registration race
  silentMiss: number; // no 4-tuple match even after the grace window — answered NO-USER
  addrMiss: number; // ports matched a live connection but the source address did not
  invalid: number; // malformed query line
  noData: number; // connection closed/timed out before sending a query line
  graceSkipped: number; // grace window declined because too many were already pending
}

const metrics: IdentdMetrics = {
  accepted: 0,
  queries: 0,
  served: 0,
  rescued: 0,
  silentMiss: 0,
  addrMiss: 0,
  invalid: 0,
  noData: 0,
  graceSkipped: 0,
};

export function getIdentdMetrics(): Readonly<IdentdMetrics> {
  return { ...metrics };
}

// Tests reset between cases; production never calls this.
export function resetIdentdMetrics(): void {
  for (const k of Object.keys(metrics) as (keyof IdentdMetrics)[]) metrics[k] = 0;
}

// Grace window for the registration race. The IRC server fires its :113 callback
// the instant it accepts our TCP connection, which can beat our own 'raw socket
// connected' handler (where registerIdent runs) through a busy event loop — a
// reconnect storm right after a deploy is the worst case. RFC 1413 servers wait
// seconds for a reply (DALnet observed at ~30s, solanum similar), so on a TOTAL
// miss we hold the socket and re-check briefly instead of answering NO-USER at
// once. A first-lookup hit still answers instantly; only the failure path waits.
// GRACE_MAX_PENDING bounds how many sockets a :113 scan can pin open.
const GRACE_MS = 1500;
const GRACE_STEP_MS = 150;
const GRACE_MAX_PENDING = 256;
let gracePending = 0;

// Throttle for the silent-miss warning so a :113 scan can't flood the log; the
// counter still increments on every miss, only the log line is rate-limited.
let lastSilentMissWarnAt = 0;

// Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4 so an address compares
// equal whether the kernel reported it mapped (common on dual-stack listeners) or
// bare — otherwise the inbound query address and the stored outbound address can
// disagree on representation alone and never match.
function normalizeAddress(address: string | undefined | null): string {
  if (!address) return '';
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return m && net.isIPv4(m[1]) ? m[1] : address;
}

// Register an outbound connection's identity. Returns a handle used later to
// unregister this exact entry (or 0 when the entry is unusable). Addresses are
// normalized up front so lookups match regardless of v4/v6-mapped representation.
export function registerIdent(entry: IdentEntry): number {
  if (!(entry.localPort > 0) || !entry.ident) return 0;
  const id = ++nextIdentId;
  idents.set(id, {
    localAddress: normalizeAddress(entry.localAddress),
    localPort: entry.localPort,
    remoteAddress: normalizeAddress(entry.remoteAddress),
    remotePort: entry.remotePort,
    ident: entry.ident,
  });
  return id;
}

export function unregisterIdent(id: number | null): void {
  if (id) idents.delete(id);
}

// Resolve the ident for an RFC 1413 query. The identifying tuple is BOTH
// addresses and BOTH ports, not just the ports. Matching ports alone (a) returns
// the wrong user when two connections share a local port and (b) lets anyone who
// can reach :113 enumerate every active ident by scanning local ports against
// 6667/6697 (TheLounge GHSA-g49q-jw42-6x85). Requiring the querier's address to
// be the server the connection actually goes to closes both. `addrMiss` flags the
// diagnostic case where the ports matched a live connection but the address did
// not.
//
// The cost of that strictness, accepted deliberately: a network whose ident
// callback originates from a different IP than its IRC listener (a
// multi-homed/load-balanced ircd, or one behind its own NAT) won't match, so its
// users go unverified. There is no fallback that ignores the address without
// reopening the enumeration hole. Mainstream ircds (solanum/charybdis/InspIRCd)
// call back from the accepting socket's IP, so this is rare — and noteAddrMiss()
// escalates loudly when it does happen, rather than failing silently.
function lookupIdent(
  lport: number,
  rport: number,
  localAddress: string,
  remoteAddress: string,
): { ident?: string; addrMiss: boolean } {
  // Linear scan, deliberately: N is the cell's live-connection count, which is
  // capacity-capped (NODE_CAPACITY) and dwarfed by each query's TCP-accept + parse
  // cost, so a query flood is bounded by connection volume (a firewall/rate-limit
  // concern), not by this. An index would add register/unregister bookkeeping to
  // keep in sync — the very dual-state that the port-only bug came from.
  let addrMiss = false;
  for (const e of idents.values()) {
    if (e.localPort !== lport || e.remotePort !== rport) continue;
    if (e.localAddress === localAddress && e.remoteAddress === remoteAddress) {
      return { ident: e.ident, addrMiss: false };
    }
    addrMiss = true;
  }
  return { addrMiss };
}

// True for loopback / RFC 1918 / link-local / IPv6 ULA & link-local — the address
// families a NAT gateway (notably Docker's bridge gateway, typically 172.x)
// substitutes for a real public source. Inputs are already normalized, so
// v4-mapped IPv6 has been collapsed to plain IPv4 before we get here.
export function isPrivateAddress(address: string): boolean {
  if (!address) return false;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (Docker's default bridge)
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) // 169.254.0.0/16 link-local
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || /^fe[89ab]/.test(v6);
}

// A query whose ports match a live connection but whose source address doesn't is
// usually harmless — a :113 scan the address check correctly refuses. But the same
// signal also marks the two wholesale failures that are hardest to diagnose from
// scattered warns, so on the FIRST such miss we escalate once with a message
// tailored to the likely cause:
//   - a PRIVATE/loopback source means the container isn't seeing real inbound IPs
//     (e.g. Docker routing :113 through its userland proxy, so every callback
//     looks like it came from the bridge gateway);
//   - a PUBLIC source that still doesn't match points at the network's ident
//     callback originating from a different IP than the server we connected to (a
//     multi-homed/load-balanced ircd; see lookupIdent) — those users can't be
//     verified, and there's no fallback that wouldn't reopen :113 enumeration.
// Escalating on any miss (not just the private one) is what surfaces the public
// case, which is the wholesale failure with no otherwise-obvious cause; the
// once-per-process gate keeps a stray scan hit from becoming log spam.
let wholesaleFailureWarned = false;
function noteAddrMiss(lport: number, rport: number, queryRemoteAddress: string): void {
  console.warn(
    `[identd] ${lport},${rport} matched a live connection but query address ${queryRemoteAddress} did not — answering NO-USER`,
  );
  if (wholesaleFailureWarned) return;
  wholesaleFailureWarned = true;
  if (isPrivateAddress(queryRemoteAddress)) {
    console.error(
      `[identd] idents are failing wholesale: a :113 callback came from ${queryRemoteAddress}, a private address — this container is not seeing IRC servers' real source IPs. Docker is most likely routing :113 through its userland proxy instead of preserving the source. Fix: run the cell with network_mode: host.`,
    );
  } else {
    console.error(
      `[identd] a :113 callback from ${queryRemoteAddress} did not match the server it was issued for. If a whole network's users show as unverified, that network's ident daemon likely originates from a different IP than its IRC listener (multi-homed/load-balanced); the enumeration-safe 4-tuple match cannot answer those.`,
    );
  }
}

interface GraceConfig {
  graceMs: number;
  graceStepMs: number;
  graceMaxPending: number;
}

// RFC 1413 reply lines. The query echoes its own port pair back ahead of the
// verdict, so both halves carry <lport>, <rport>.
const useridReply = (lport: number, rport: number, ident: string): string =>
  `${lport}, ${rport} : USERID : UNIX : ${ident}\r\n`;
const noUserReply = (lport: number, rport: number): string =>
  `${lport}, ${rport} : ERROR : NO-USER\r\n`;

// RFC 1413: the querying server sends "<our-port> , <their-port>"; we reply
// "<our-port>, <their-port> : USERID : UNIX : <ident>" or ERROR : NO-USER. The
// query connection's own addresses complete the 4-tuple we match on. A TOTAL
// miss (no entry with these ports) is treated as a possible registration race
// and given the grace window; an ADDRESS mismatch is the enumeration-refusal
// case and answered NO-USER at once (see lookupIdent / noteAddrMiss).
function handleConnection(socket: net.Socket, cfg: GraceConfig): void {
  metrics.accepted++;
  socket.setTimeout(10_000);
  const queryLocalAddress = normalizeAddress(socket.localAddress);
  const queryRemoteAddress = normalizeAddress(socket.remoteAddress);
  let buf = '';
  let answered = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCounted = false;

  // Single exit: clear any pending grace timer, release the pending slot, reply.
  // Every gracePending decrement goes through the pendingCounted guard so the
  // grace-timer path and the socket 'close' path can't double-count.
  const finish = (line: string): void => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (pendingCounted) {
      gracePending--;
      pendingCounted = false;
    }
    socket.end(line);
  };

  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    buf += chunk.toString('latin1');
    const nl = buf.indexOf('\n');
    if (nl === -1) {
      if (buf.length > 100) socket.destroy(); // junk, no newline — bail
      return;
    }
    const m = /^\s*(\d{1,5})\s*,\s*(\d{1,5})/.exec(buf.slice(0, nl));
    if (!m) {
      answered = true;
      metrics.invalid++;
      finish('0, 0 : ERROR : INVALID-PORT\r\n');
      return;
    }
    answered = true;
    metrics.queries++;
    const lport = Number(m[1]);
    const rport = Number(m[2]);

    const first = lookupIdent(lport, rport, queryLocalAddress, queryRemoteAddress);
    if (first.ident) {
      metrics.served++;
      finish(useridReply(lport, rport, first.ident));
      return;
    }
    if (first.addrMiss) {
      metrics.addrMiss++;
      noteAddrMiss(lport, rport, queryRemoteAddress);
      finish(noUserReply(lport, rport));
      return;
    }
    // Total miss: most likely our outbound registration hasn't landed yet.
    // Decline the wait under overload so a scan can't pin sockets open.
    if (gracePending >= cfg.graceMaxPending) {
      metrics.graceSkipped++;
      metrics.silentMiss++;
      finish(noUserReply(lport, rport));
      return;
    }
    gracePending++;
    pendingCounted = true;
    const startedAt = Date.now();
    const recheck = (): void => {
      graceTimer = null;
      if (socket.destroyed) {
        if (pendingCounted) {
          gracePending--;
          pendingCounted = false;
        }
        return;
      }
      const again = lookupIdent(lport, rport, queryLocalAddress, queryRemoteAddress);
      if (again.ident) {
        metrics.rescued++;
        console.log(
          `[identd] ${lport},${rport} matched after ${Date.now() - startedAt}ms — outbound registration landed late (connect race); answering USERID`,
        );
        finish(useridReply(lport, rport, again.ident));
        return;
      }
      if (again.addrMiss) {
        metrics.addrMiss++;
        noteAddrMiss(lport, rport, queryRemoteAddress);
        finish(noUserReply(lport, rport));
        return;
      }
      if (Date.now() - startedAt >= cfg.graceMs) {
        metrics.silentMiss++;
        const now = Date.now();
        if (now - lastSilentMissWarnAt > 10_000) {
          lastSilentMissWarnAt = now;
          console.warn(
            `[identd] no live connection for ${lport},${rport} from ${queryRemoteAddress} after ${cfg.graceMs}ms — answering NO-USER (silentMiss=${metrics.silentMiss})`,
          );
        }
        finish(noUserReply(lport, rport));
        return;
      }
      graceTimer = setTimeout(recheck, cfg.graceStepMs);
    };
    graceTimer = setTimeout(recheck, cfg.graceStepMs);
  });

  socket.on('timeout', () => socket.destroy());
  socket.on('close', () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (pendingCounted) {
      gracePending--;
      pendingCounted = false;
    }
    // Accepted but never delivered a query line — the starvation/connectivity
    // signature, distinct from a query we did answer with NO-USER.
    if (!answered) metrics.noData++;
  });
  socket.on('error', () => {});
}

/** Build (but don't listen on) an identd server. Exposed for tests, which pass
 * a short grace window to keep the race cases fast and deterministic. */
export function createIdentdServer(opts: Partial<GraceConfig> = {}): net.Server {
  const cfg: GraceConfig = {
    graceMs: opts.graceMs ?? GRACE_MS,
    graceStepMs: opts.graceStepMs ?? GRACE_STEP_MS,
    graceMaxPending: opts.graceMaxPending ?? GRACE_MAX_PENDING,
  };
  return net.createServer((socket) => handleConnection(socket, cfg));
}

let server: net.Server | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;

// Roll the outcome counters into one greppable line every 10 minutes, but only
// when something happened since the last tick — an idle cell stays quiet. This
// is how the race/miss rate becomes observable in prod without per-query spam.
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000;

function startSummary(): void {
  if (summaryTimer) return;
  let prevAccepted = 0;
  summaryTimer = setInterval(() => {
    if (metrics.accepted === prevAccepted) return;
    prevAccepted = metrics.accepted;
    const resolved = metrics.served + metrics.rescued + metrics.silentMiss;
    const ok = resolved ? Math.round(((metrics.served + metrics.rescued) / resolved) * 100) : 100;
    console.log(
      `[identd] stats: served=${metrics.served} rescued=${metrics.rescued} silentMiss=${metrics.silentMiss} addrMiss=${metrics.addrMiss} noData=${metrics.noData} graceSkipped=${metrics.graceSkipped} — ident success ${ok}%`,
    );
  }, SUMMARY_INTERVAL_MS);
  // Don't let the summary timer keep the process alive on its own.
  summaryTimer.unref();
}

export function startIdentd(port: number): void {
  if (server) return;
  const srv = createIdentdServer();
  srv.on('error', (err: Error) => {
    // A failed bind (EACCES without the privilege to bind :113, or EADDRINUSE)
    // must not take down the whole server — log and carry on without identd. If
    // the error arrives after we were already listening, close the listener so
    // it can't keep accepting connections once we drop our reference to it.
    console.error(`[identd] failed to listen on :${port}: ${err.message}`);
    if (srv.listening) srv.close();
    if (server === srv) server = null;
  });
  srv.listen(port, () =>
    console.log(
      `[identd] listening on :${port} — verifying idents against the full RFC 1413 4-tuple, with a ${GRACE_MS}ms grace window to absorb the connect/registration race; relies on the container seeing IRC servers' real inbound source IPs (Docker bridge preserves them; if idents fail wholesale, run with network_mode: host)`,
    ),
  );
  server = srv;
  startSummary();
}

export function stopIdentd(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}

export function isIdentdEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LURKER_IDENTD_ENABLED || '').trim());
}

export function identdPort(): number {
  const p = Number(process.env.LURKER_IDENTD_PORT);
  return Number.isInteger(p) && p > 0 ? p : 113;
}
