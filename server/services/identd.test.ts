// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'net';
import {
  createIdentdServer,
  registerIdent,
  unregisterIdent,
  isPrivateAddress,
  getIdentdMetrics,
  resetIdentdMetrics,
} from './identd.js';

let server: net.Server;
let port: number;

beforeAll(async () => {
  // The address-mismatch tests exercise the NO-USER diagnostic path (warn/error)
  // and the grace path logs a line on every rescue; mute all three so the run
  // output stays clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // A short grace window keeps the legitimate-miss cases (which now route
  // through the grace path before answering NO-USER) fast; the dedicated
  // grace-window describe below pins the timing behavior itself.
  server = createIdentdServer({ graceMs: 150, graceStepMs: 30 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => {
  server.close();
  vi.restoreAllMocks();
});

// The query connects from loopback to the loopback listener, so the identd
// server sees both the local and remote address of the query as 127.0.0.1 —
// register with those so the 4-tuple matches. (In production the registered
// remote address is the IRC server, and the query legitimately arrives FROM it.)
const LOOPBACK = '127.0.0.1';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Send one ident query line and collect the reply.
function query(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(line));
    let out = '';
    c.on('data', (d) => (out += d.toString()));
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

describe('built-in identd', () => {
  it('returns USERID when the full 4-tuple matches a registered connection', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40001,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u42',
    });
    const res = await query('40001, 6667\r\n');
    expect(res.trim()).toBe('40001, 6667 : USERID : UNIX : u42');
  });

  it('returns NO-USER for an unregistered port', async () => {
    const res = await query('40002, 6667\r\n');
    expect(res.trim()).toBe('40002, 6667 : ERROR : NO-USER');
  });

  it('returns NO-USER after the entry is unregistered by its handle', async () => {
    const id = registerIdent({
      localAddress: LOOPBACK,
      localPort: 40003,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u9',
    });
    unregisterIdent(id);
    const res = await query('40003, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
  });

  it('rejects a malformed query', async () => {
    const res = await query('not a query\r\n');
    expect(res).toContain('ERROR : INVALID-PORT');
  });

  it('tolerates loose whitespace in the query', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40004,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'u1',
    });
    const res = await query('  40004 , 6667 \r\n');
    expect(res).toContain('USERID : UNIX : u1');
  });

  // GHSA-g49q-jw42-6x85: matching ports alone leaks idents to anyone who can
  // reach :113. A query whose ports match but whose remote address is not the
  // server the connection goes to must get NO-USER, never the user's ident.
  it('refuses to answer when ports match but the remote address does not (no enumeration)', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40005,
      remoteAddress: '198.51.100.7', // a different server than the loopback querier
      remotePort: 6667,
      ident: 'secret',
    });
    const res = await query('40005, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
    expect(res).not.toContain('secret');
  });

  it('refuses when the foreign port differs — it is part of the identifying tuple', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40006,
      remoteAddress: LOOPBACK,
      remotePort: 6697,
      ident: 'u6',
    });
    const res = await query('40006, 9999\r\n'); // right local port, wrong foreign port
    expect(res).toContain('ERROR : NO-USER');
  });

  it('matches across IPv4-mapped-IPv6 vs bare IPv4 representation', async () => {
    registerIdent({
      localAddress: '::ffff:127.0.0.1',
      localPort: 40007,
      remoteAddress: '::ffff:127.0.0.1',
      remotePort: 6667,
      ident: 'mapped',
    });
    const res = await query('40007, 6667\r\n'); // querier reports bare 127.0.0.1
    expect(res).toContain('USERID : UNIX : mapped');
  });

  // Two simultaneous connections legally sharing a local source port (to
  // different servers) must each resolve to their own ident, and closing one
  // must not delete the other — the failure mode of port-only keying.
  it('keeps colliding local ports distinct and unregisters them independently', async () => {
    const idA = registerIdent({
      localAddress: LOOPBACK,
      localPort: 40008,
      remoteAddress: LOOPBACK,
      remotePort: 6667, // "server A"
      ident: 'alice',
    });
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 40008, // same local port…
      remoteAddress: LOOPBACK,
      remotePort: 7000, // …different server B
      ident: 'bob',
    });

    expect(await query('40008, 6667\r\n')).toContain('USERID : UNIX : alice');
    expect(await query('40008, 7000\r\n')).toContain('USERID : UNIX : bob');

    // Closing A must leave B answerable.
    unregisterIdent(idA);
    expect(await query('40008, 6667\r\n')).toContain('ERROR : NO-USER');
    expect(await query('40008, 7000\r\n')).toContain('USERID : UNIX : bob');
  });

  // The canonical multi-user case identd exists for: two users on the SAME
  // network from one cell. The OS forces their local source ports to differ (the
  // 4-tuple to an identical destination must be unique), so identd tells them
  // apart by port. No cross-talk.
  it('disambiguates two users on the same network by their distinct local ports', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 41001,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'lu1',
    });
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 41002,
      remoteAddress: LOOPBACK,
      remotePort: 6667, // same server as lu1
      ident: 'lu2',
    });

    expect(await query('41001, 6667\r\n')).toContain('USERID : UNIX : lu1');
    expect(await query('41002, 6667\r\n')).toContain('USERID : UNIX : lu2');
  });
});

// The residual ~7% failure after the pre-TLS-registration fix: the IRC server's
// :113 callback can beat our own registerIdent through a busy event loop, so the
// query arrives before any matching 4-tuple exists. Answering NO-USER on that
// first miss is the bug; the grace window holds the socket and re-checks so a
// registration that lands a few ms late still yields USERID. (issue #374)
describe('identd grace window (registration race)', () => {
  let graceServer: net.Server;
  let gracePort: number;

  beforeAll(async () => {
    resetIdentdMetrics();
    // Short window so the race cases stay fast and deterministic.
    graceServer = createIdentdServer({ graceMs: 600, graceStepMs: 40, graceMaxPending: 4 });
    await new Promise<void>((resolve) => graceServer.listen(0, '127.0.0.1', resolve));
    gracePort = (graceServer.address() as net.AddressInfo).port;
  });

  afterAll(() => graceServer.close());

  function graceQuery(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = net.connect(gracePort, '127.0.0.1', () => c.write(line));
      let out = '';
      c.on('data', (d) => (out += d.toString()));
      c.on('end', () => resolve(out));
      c.on('error', reject);
    });
  }

  // The core fix: a query that arrives before the outbound connection registers
  // its 4-tuple must wait out the window, not get an instant NO-USER.
  it('rescues a query when registration lands during the grace window', async () => {
    const pending = graceQuery('42100, 6667\r\n'); // nothing registered yet
    await delay(120); // a few rechecks in, still well inside the 600ms window
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42100,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'raced',
    });
    expect(await pending).toContain('USERID : UNIX : raced');
    expect(getIdentdMetrics().rescued).toBeGreaterThanOrEqual(1);
  });

  it('answers NO-USER when nothing registers before the window expires', async () => {
    const before = getIdentdMetrics().silentMiss;
    expect(await graceQuery('42199, 6667\r\n')).toContain('ERROR : NO-USER');
    expect(getIdentdMetrics().silentMiss).toBe(before + 1);
  });

  it('answers an exact match immediately without sitting through the window', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42101,
      remoteAddress: LOOPBACK,
      remotePort: 6667,
      ident: 'fast',
    });
    const t0 = Date.now();
    expect(await graceQuery('42101, 6667\r\n')).toContain('USERID : UNIX : fast');
    expect(Date.now() - t0).toBeLessThan(300); // did not wait the 600ms grace
  });

  // Enumeration protection must not be softened by the grace window: a ports
  // match with the wrong source address is refused at once, not held open.
  it('still refuses an address mismatch instantly (no grace for enumeration)', async () => {
    registerIdent({
      localAddress: LOOPBACK,
      localPort: 42102,
      remoteAddress: '198.51.100.9', // a different server than the loopback querier
      remotePort: 6667,
      ident: 'secret',
    });
    const t0 = Date.now();
    const res = await graceQuery('42102, 6667\r\n');
    expect(res).toContain('ERROR : NO-USER');
    expect(res).not.toContain('secret');
    expect(Date.now() - t0).toBeLessThan(300);
  });
});

// Drives the one-time "idents failing wholesale" diagnostic: a callback whose
// source is a private/gateway address means the container isn't seeing real
// source IPs. Getting a range boundary wrong here would either miss the Docker
// case or cry wolf on real public servers, so pin the classification.
describe('isPrivateAddress', () => {
  it('flags loopback, RFC 1918, and link-local IPv4', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.10.20')).toBe(true);
  });

  it('flags the whole 172.16.0.0/12 Docker-bridge range but not its edges', () => {
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.17.0.1')).toBe(true); // Docker's default gateway
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('172.15.0.1')).toBe(false); // just below /12
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just above /12
  });

  it('treats real public IPv4 as public', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('198.51.100.7')).toBe(false);
    expect(isPrivateAddress('1.2.3.4')).toBe(false);
  });

  it('flags loopback, ULA, and link-local IPv6 but not global IPv6', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
  });

  it('treats an empty/unknown address as not private', () => {
    expect(isPrivateAddress('')).toBe(false);
  });
});
