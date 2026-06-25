// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// E2eManager — the orchestration layer that ties the RPE2E crypto primitives
// (server/services/e2e/*) to the keyring (server/db/e2e.ts). A faithful port of
// repartee's manager.rs, adapted for Lurker's multi-tenant cell: it is a single
// process-wide instance whose in-memory state (pending handshakes, rate limiter,
// replay cache, identity cache) is keyed by (userId, networkId).
//
// It is IRC-agnostic: callers hand it parsed inbound bodies / plaintext / wire
// lines and it returns the bodies to send back, the wire lines to put on the
// wire, or a decrypt outcome. The IRC layer (a later phase) owns the actual
// NOTICE/PRIVMSG plumbing and the channel-vs-@handle `context` derivation.
//
// Security ordering, mirrored from the reference: rate-limit BEFORE crypto;
// verify signatures BEFORE touching state; install sessions under strict TOFU.

import { randomBytes } from 'node:crypto';

import { buildAad } from './aad.js';
import * as aead from './aead.js';
import { splitPlaintext } from './chunker.js';
import { DEFAULT_TS_TOLERANCE_SECS, rekeyInfo, wrapInfo } from './constants.js';
import { deriveWrapKey, ed25519SeedToX25519, generateEphemeral } from './ecdh.js';
import { utf8 } from './encoding.js';
import { fingerprint, fingerprintHex, fingerprintWords } from './fingerprint.js';
import {
  encodeKeyReq,
  encodeKeyRsp,
  type KeyRekey,
  type KeyReq,
  type KeyRsp,
  parseHandshake,
  sigPayloadKeyRekey,
  sigPayloadKeyReq,
  sigPayloadKeyRsp,
} from './handshake.js';
import { generateIdentity, type Identity, identityFromSeed, sign, verify } from './identity.js';
import { encodeChunk, freshMsgid, parseChunk } from './wire.js';
import * as keyring from '../../db/e2e.js';
import { HandleMismatchError } from '../../db/e2e.js';
import { RateLimiter } from './rateLimiter.js';
import { ReplayCache } from './replayCache.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── public result shapes ────────────────────────────────────────────────────

export interface IdentityInfo {
  publicKey: Uint8Array;
  fingerprint: Uint8Array;
  fingerprintHex: string;
  /** Six-word BIP-39 short-authentication-string for out-of-band verification. */
  sas: string;
}

export interface UserNotice {
  level: 'info' | 'warn';
  text: string;
}

/** The result of handling an inbound handshake body: bodies to NOTICE back to
 *  the sender, and an optional user-facing notice for the buffer. */
export interface HandshakeOutcome {
  replies: string[];
  notice?: UserNotice;
}

export type DecryptOutcome =
  | { kind: 'plaintext'; text: string }
  | { kind: 'cleartext'; text: string } // not an RPE2E line — pass through
  | { kind: 'missing-key' }
  | { kind: 'replay' }
  | { kind: 'rejected'; reason: string };

// ─── internal state ──────────────────────────────────────────────────────────

interface PendingHandshake {
  userId: number;
  networkId: number;
  channel: string;
  peerHandle: string | null;
  ephSecret: Uint8Array; // initiator's ephemeral X25519 secret
}

type ClassifyResult = 'new' | 'known' | 'fingerprint-changed' | 'revoked';

export interface E2eManagerOptions {
  /** Epoch-ms clock, injectable for tests. */
  now?: () => number;
  tsToleranceSecs?: number;
}

export class E2eManager {
  private readonly now: () => number;
  private readonly tsToleranceSecs: number;
  private readonly identities = new Map<number, Identity>();
  private readonly pending = new Map<string, PendingHandshake>();
  private readonly pendingInbound = new Map<string, KeyReq>(); // normal-mode cached KEYREQs
  private readonly rateLimiter: RateLimiter;
  private readonly replay: ReplayCache;

  constructor(opts: E2eManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tsToleranceSecs = opts.tsToleranceSecs ?? DEFAULT_TS_TOLERANCE_SECS;
    this.rateLimiter = new RateLimiter(this.now);
    this.replay = new ReplayCache(8192, this.now);
  }

  private nowUnix(): number {
    return Math.floor(this.now() / 1000);
  }

  private rlKey(userId: number, networkId: number, handle: string): string {
    return `${userId}:${networkId}:${handle}`;
  }

  // ─── identity ──────────────────────────────────────────────────────────────

  /** Load (or first-time generate + persist) this account's identity. Cached. */
  private loadIdentity(userId: number): Identity {
    const cached = this.identities.get(userId);
    if (cached) return cached;

    const row = keyring.loadIdentity(userId);
    let id: Identity;
    if (row) {
      id = identityFromSeed(row.privkey);
      // Self-consistency: a stored pubkey/fingerprint that doesn't match the
      // secret means the keyring drifted — fail loud rather than sign with a
      // mismatched identity.
      if (!bytesEqual(id.publicKey, row.pubkey)) {
        throw new Error('e2e: stored identity pubkey does not match secret');
      }
      if (!bytesEqual(fingerprint(id.publicKey), row.fingerprint)) {
        throw new Error('e2e: stored identity fingerprint does not match pubkey');
      }
    } else {
      id = generateIdentity();
      keyring.saveIdentity(userId, {
        pubkey: id.publicKey,
        privkey: id.secretKey,
        fingerprint: fingerprint(id.publicKey),
        createdAt: this.nowUnix(),
      });
    }
    this.identities.set(userId, id);
    return id;
  }

  /** Public identity info for `/e2e fingerprint` / the lock UI. */
  getIdentity(userId: number): IdentityInfo {
    const id = this.loadIdentity(userId);
    const fp = fingerprint(id.publicKey);
    return {
      publicKey: id.publicKey,
      fingerprint: fp,
      fingerprintHex: fingerprintHex(fp),
      sas: fingerprintWords(fp),
    };
  }

  // ─── channel config ──────────────────────────────────────────────────────────

  setChannelConfig(
    userId: number,
    networkId: number,
    channel: string,
    enabled: boolean,
    mode: keyring.ChannelMode,
  ): void {
    keyring.setChannelConfig(userId, networkId, { channel, enabled, mode });
  }

  // ─── outbound handshake ──────────────────────────────────────────────────────

  /** Build a KEYREQ to initiate (or extend) an encrypted session on `channel`,
   *  returning the CTCP body to NOTICE to the peer. Stores the pending ephemeral
   *  secret so the matching KEYRSP can be unwrapped. */
  buildKeyReq(userId: number, networkId: number, channel: string, peerHandle?: string): string {
    const req = this.buildKeyReqStruct(userId, networkId, channel, peerHandle ?? null);
    return encodeKeyReq(req);
  }

  private buildKeyReqStruct(
    userId: number,
    networkId: number,
    channel: string,
    peerHandle: string | null,
  ): KeyReq {
    const id = this.loadIdentity(userId);
    const nonce = new Uint8Array(randomBytes(16));
    const eph = generateEphemeral();
    const pubkey = id.publicKey;
    const sigPayload = sigPayloadKeyReq(channel, pubkey, eph.publicKey, nonce);
    const sig = sign(id.secretKey, sigPayload);

    const nonceHex = Buffer.from(nonce).toString('hex');
    this.pending.set(`${userId}:${networkId}:${channel}:${nonceHex}`, {
      userId,
      networkId,
      channel,
      peerHandle,
      ephSecret: eph.secretKey,
    });

    return { channel, pubkey, ephX25519: eph.publicKey, nonce, sig };
  }

  // ─── inbound handshake dispatch ──────────────────────────────────────────────

  /**
   * Process an inbound RPEE2E CTCP body. Returns `null` if it is not an RPEE2E
   * message (caller falls through to other CTCP handling), otherwise the bodies
   * to NOTICE back to `senderHandle`'s nick plus an optional user notice.
   */
  handleHandshakeBody(
    userId: number,
    networkId: number,
    senderHandle: string,
    senderNick: string | null,
    body: string,
  ): HandshakeOutcome | null {
    let parsed;
    try {
      parsed = parseHandshake(body);
    } catch {
      return { replies: [] }; // malformed RPEE2E — drop quietly
    }
    if (!parsed) return null;
    switch (parsed.kind) {
      case 'KEYREQ':
        return this.handleKeyReq(userId, networkId, senderHandle, senderNick, parsed.msg);
      case 'KEYRSP':
        return this.handleKeyRsp(userId, networkId, senderHandle, parsed.msg);
      case 'REKEY':
        return this.handleRekey(userId, networkId, senderHandle, parsed.msg);
      default:
        return { replies: [] };
    }
  }

  private handleKeyReq(
    userId: number,
    networkId: number,
    senderHandle: string,
    senderNick: string | null,
    req: KeyReq,
  ): HandshakeOutcome {
    // Rate-limit gate FIRST — reject a flood before any crypto work.
    if (!this.rateLimiter.allowIncoming(this.rlKey(userId, networkId, senderHandle))) {
      return { replies: [] };
    }
    // Verify the signature (binds the ephemeral) before touching any state.
    const payload = sigPayloadKeyReq(req.channel, req.pubkey, req.ephX25519, req.nonce);
    if (!verify(req.pubkey, payload, req.sig)) return { replies: [] };

    const mode = this.effectiveMode(userId, networkId, senderHandle, req.channel);
    if (mode === null) return { replies: [] }; // channel not enabled

    const fp = fingerprint(req.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    if (change === 'revoked' || change === 'fingerprint-changed') {
      return { replies: [], notice: this.tofuWarning(senderHandle, change) };
    }
    this.upsertSeenPeer(userId, networkId, fp, req.pubkey, senderHandle, senderNick);

    const alreadyTrusted = this.hasTrustedIncoming(userId, networkId, senderHandle, req.channel);
    if (mode === 'normal' && !alreadyTrusted) {
      // Cache for `/e2e accept`, prompt the user, and don't respond yet.
      this.pendingInbound.set(this.inboundKey(userId, networkId, senderHandle, req.channel), req);
      const who = senderNick ?? senderHandle;
      return {
        replies: [],
        notice: {
          level: 'info',
          text: `${who} wants to start an encrypted session on ${req.channel} — /e2e accept ${who}`,
        },
      };
    }
    if (mode === 'quiet' && !alreadyTrusted) return { replies: [] };

    // auto-accept, or normal/quiet with an already-trusted peer → respond.
    return this.buildKeyRspAndReciprocal(userId, networkId, senderHandle, req);
  }

  private handleKeyRsp(
    userId: number,
    networkId: number,
    senderHandle: string,
    rsp: KeyRsp,
  ): HandshakeOutcome {
    const payload = sigPayloadKeyRsp(
      rsp.channel,
      rsp.pubkey,
      rsp.ephemeralPub,
      rsp.wrapNonce,
      rsp.wrapCt,
      rsp.nonce,
    );
    if (!verify(rsp.pubkey, payload, rsp.sig)) return { replies: [] };

    const sk = this.consumePendingForKeyRsp(userId, networkId, rsp);
    if (!sk) return { replies: [] }; // no matching pending handshake

    const fp = fingerprint(rsp.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    if (change === 'revoked' || change === 'fingerprint-changed') {
      return { replies: [], notice: this.tofuWarning(senderHandle, change) };
    }
    // We initiated, so receiving the response is our consent → trust the peer.
    const now = this.nowUnix();
    keyring.upsertPeer(userId, networkId, {
      fingerprint: fp,
      pubkey: rsp.pubkey,
      lastHandle: senderHandle,
      lastNick: null,
      firstSeen: now,
      lastSeen: now,
      globalStatus: 'trusted',
    });
    keyring.setPeerStatus(userId, networkId, fp, 'trusted');

    try {
      keyring.installIncomingSessionStrict(userId, networkId, {
        handle: senderHandle,
        channel: rsp.channel,
        fingerprint: fp,
        sk,
        status: 'trusted',
        createdAt: now,
      });
    } catch (err) {
      if (err instanceof HandleMismatchError) {
        return { replies: [], notice: this.tofuWarning(senderHandle, 'fingerprint-changed') };
      }
      throw err;
    }
    return {
      replies: [],
      notice: { level: 'info', text: `Encrypted session established with ${senderHandle}` },
    };
  }

  private handleRekey(
    userId: number,
    networkId: number,
    senderHandle: string,
    rekey: KeyRekey,
  ): HandshakeOutcome {
    const payload = sigPayloadKeyRekey(
      rekey.channel,
      rekey.pubkey,
      rekey.ephPub,
      rekey.wrapNonce,
      rekey.wrapCt,
      rekey.nonce,
    );
    if (!verify(rekey.pubkey, payload, rekey.sig)) return { replies: [] };

    const fp = fingerprint(rekey.pubkey);
    const change = this.classifyPeerChange(userId, networkId, fp, senderHandle);
    // A REKEY from a peer we've never handshaked with is illegitimate.
    if (change === 'new') return { replies: [] };
    if (change === 'revoked' || change === 'fingerprint-changed') {
      return { replies: [], notice: this.tofuWarning(senderHandle, change) };
    }

    // ECDH from OUR Ed25519 identity (converted to X25519) with their fresh
    // ephemeral, HKDF under the REKEY domain separator.
    const id = this.loadIdentity(userId);
    const myScalar = ed25519SeedToX25519(id.secretKey);
    const info = utf8.encode(rekeyInfo(rekey.channel));
    const wrapKey = deriveWrapKey(myScalar, rekey.ephPub, info);
    let sk: Uint8Array;
    try {
      sk = aead.decrypt(wrapKey, rekey.wrapNonce, info, rekey.wrapCt);
    } catch {
      return { replies: [] };
    }
    if (sk.length !== 32) return { replies: [] };

    try {
      keyring.installIncomingSessionStrict(userId, networkId, {
        handle: senderHandle,
        channel: rekey.channel,
        fingerprint: fp,
        sk,
        status: 'trusted',
        createdAt: this.nowUnix(),
      });
    } catch (err) {
      if (err instanceof HandleMismatchError) {
        return { replies: [], notice: this.tofuWarning(senderHandle, 'fingerprint-changed') };
      }
      throw err;
    }
    return { replies: [] };
  }

  /** Accept a normal-mode KEYREQ cached for `/e2e accept`. */
  acceptPending(
    userId: number,
    networkId: number,
    senderHandle: string,
    channel: string,
  ): HandshakeOutcome {
    const key = this.inboundKey(userId, networkId, senderHandle, channel);
    const req = this.pendingInbound.get(key);
    if (!req) {
      return { replies: [], notice: { level: 'warn', text: 'no pending handshake to accept' } };
    }
    this.pendingInbound.delete(key);
    return this.buildKeyRspAndReciprocal(userId, networkId, senderHandle, req);
  }

  // Build the KEYRSP (wrapping our outgoing key) for `req`, plus a reciprocal
  // KEYREQ so the peer sends us their key too (symmetric handshake).
  private buildKeyRspAndReciprocal(
    userId: number,
    networkId: number,
    senderHandle: string,
    req: KeyReq,
  ): HandshakeOutcome {
    const id = this.loadIdentity(userId);
    const fp = fingerprint(req.pubkey);
    const ourSk = this.getOrGenerateOutgoingKey(userId, networkId, req.channel);
    keyring.recordOutgoingRecipient(
      userId,
      networkId,
      req.channel,
      senderHandle,
      fp,
      this.nowUnix(),
    );

    const ourEph = generateEphemeral();
    const info = utf8.encode(wrapInfo(req.channel));
    const wrapKey = deriveWrapKey(ourEph.secretKey, req.ephX25519, info);
    const sealed = aead.encrypt(wrapKey, info, ourSk);

    const rspNonce = new Uint8Array(randomBytes(16));
    const rspPayload = sigPayloadKeyRsp(
      req.channel,
      id.publicKey,
      ourEph.publicKey,
      sealed.nonce,
      sealed.ciphertext,
      rspNonce,
    );
    const rsp: KeyRsp = {
      channel: req.channel,
      pubkey: id.publicKey,
      ephemeralPub: ourEph.publicKey,
      wrapNonce: sealed.nonce,
      wrapCt: sealed.ciphertext,
      nonce: rspNonce,
      sig: sign(id.secretKey, rspPayload),
    };

    const replies = [encodeKeyRsp(rsp)];
    // Reciprocal KEYREQ unless we already hold their key, rate-limited.
    if (
      !this.hasTrustedIncoming(userId, networkId, senderHandle, req.channel) &&
      this.rateLimiter.allowOutgoing(this.rlKey(userId, networkId, senderHandle))
    ) {
      replies.push(
        encodeKeyReq(this.buildKeyReqStruct(userId, networkId, req.channel, senderHandle)),
      );
    }
    return { replies };
  }

  private consumePendingForKeyRsp(
    userId: number,
    networkId: number,
    rsp: KeyRsp,
  ): Uint8Array | null {
    const info = utf8.encode(wrapInfo(rsp.channel));
    for (const [key, ph] of this.pending) {
      if (ph.userId !== userId || ph.networkId !== networkId || ph.channel !== rsp.channel)
        continue;
      try {
        const wrapKey = deriveWrapKey(ph.ephSecret, rsp.ephemeralPub, info);
        const sk = aead.decrypt(wrapKey, rsp.wrapNonce, info, rsp.wrapCt);
        if (sk.length !== 32) continue;
        this.pending.delete(key); // consume only on success
        return sk;
      } catch {
        // Not the matching pending entry — the AEAD tag discriminates.
        continue;
      }
    }
    return null;
  }

  // ─── encrypt / decrypt ───────────────────────────────────────────────────────

  /** Encrypt `plaintext` for `channel` into `+RPE2E01` wire lines, or `null`
   *  if E2E is not enabled for the channel. */
  encryptOutgoing(
    userId: number,
    networkId: number,
    channel: string,
    plaintext: string,
  ): string[] | null {
    const cfg = keyring.getChannelConfig(userId, networkId, channel);
    if (!cfg || !cfg.enabled) return null;

    const sk = this.getOrGenerateOutgoingKey(userId, networkId, channel);
    const chunks = splitPlaintext(plaintext);
    const total = chunks.length;
    const msgid = freshMsgid();
    const ts = this.nowUnix();

    return chunks.map((chunk, idx) => {
      const part = idx + 1;
      const aad = buildAad(channel, msgid, ts, part, total);
      const sealed = aead.encrypt(sk, aad, chunk);
      return encodeChunk({
        msgid,
        ts,
        part,
        total,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
      });
    });
  }

  /** Decrypt one inbound wire line. */
  decryptIncoming(
    userId: number,
    networkId: number,
    senderHandle: string,
    channel: string,
    line: string,
  ): DecryptOutcome {
    let wire;
    try {
      wire = parseChunk(line);
    } catch {
      return { kind: 'rejected', reason: 'malformed RPE2E line' };
    }
    if (!wire) return { kind: 'cleartext', text: line };

    const skew = Math.abs(this.nowUnix() - wire.ts);
    if (skew > this.tsToleranceSecs) {
      return { kind: 'rejected', reason: `ts outside tolerance window (${skew}s skew)` };
    }

    const sess = keyring.getIncomingSession(userId, networkId, senderHandle, channel);
    if (!sess) return { kind: 'missing-key' };
    if (sess.status !== 'trusted') return { kind: 'rejected', reason: `peer not trusted` };

    const aad = buildAad(channel, wire.msgid, wire.ts, wire.part, wire.total);
    let pt: Uint8Array;
    try {
      pt = aead.decrypt(sess.sk, wire.nonce, aad, wire.ciphertext);
    } catch {
      return { kind: 'rejected', reason: 'authentication failed' };
    }
    let text: string;
    try {
      text = decoder.decode(pt);
    } catch {
      return { kind: 'rejected', reason: 'invalid utf-8' };
    }

    // Replay check only AFTER a chunk authenticates, so unauthenticated traffic
    // can't poison the cache. ttl past the ts window covers the replay horizon.
    const replayKey = `${userId}:${networkId}:${channel}:${senderHandle}:${Buffer.from(
      wire.msgid,
    ).toString('hex')}:${wire.part}`;
    if (!this.replay.observe(replayKey, (this.tsToleranceSecs * 2 + 5) * 1000)) {
      return { kind: 'replay' };
    }
    return { kind: 'plaintext', text };
  }

  // ─── trust operations ────────────────────────────────────────────────────────

  /** Their fingerprint + SAS for `/e2e verify <nick>`, or null if unknown. */
  verifyInfo(
    userId: number,
    networkId: number,
    handle: string,
  ): { fingerprintHex: string; sas: string; status: keyring.TrustStatus } | null {
    const peer = keyring.getPeerByHandle(userId, networkId, handle);
    if (!peer) return null;
    return {
      fingerprintHex: fingerprintHex(peer.fingerprint),
      sas: fingerprintWords(peer.fingerprint),
      status: peer.globalStatus,
    };
  }

  /** Revoke a peer: mark the global peer + every session for the handle revoked,
   *  so we stop decrypting their traffic. */
  revokePeer(userId: number, networkId: number, handle: string): boolean {
    const peer = keyring.getPeerByHandle(userId, networkId, handle);
    if (peer) keyring.setPeerStatus(userId, networkId, peer.fingerprint, 'revoked');
    let found = false;
    for (const s of keyring.listIncomingSessions(userId, networkId)) {
      if (s.handle.toLowerCase() === handle.toLowerCase()) {
        keyring.updateIncomingStatus(userId, networkId, s.handle, s.channel, 'revoked');
        found = true;
      }
    }
    return found || peer !== null;
  }

  /** Forget a peer entirely so the next handshake re-pins (TOFU reset). Returns
   *  the number of rows cleared. */
  reverifyPeer(userId: number, networkId: number, handle: string): number {
    let cleared = 0;
    const peer = keyring.getPeerByHandle(userId, networkId, handle);
    if (peer) {
      keyring.deletePeerByFingerprint(userId, networkId, peer.fingerprint);
      cleared += 1;
    }
    cleared += keyring.deleteIncomingSessionsForHandle(userId, networkId, handle);
    cleared += keyring.deleteOutgoingRecipientsForHandle(userId, networkId, handle);
    const inboundPrefix = `${userId}:${networkId}:${handle}:`;
    for (const key of this.pendingInbound.keys()) {
      if (key.startsWith(inboundPrefix)) this.pendingInbound.delete(key);
    }
    return cleared;
  }

  // ─── private helpers ─────────────────────────────────────────────────────────

  private getOrGenerateOutgoingKey(userId: number, networkId: number, channel: string): Uint8Array {
    const sess = keyring.getOutgoingSession(userId, networkId, channel);
    if (sess && !sess.pendingRotation) return sess.sk;
    // No session yet, or a rotation is pending — generate a fresh key. (REKEY
    // distribution to existing recipients is a Phase-2 channel feature.)
    const fresh = aead.generateSessionKey();
    keyring.setOutgoingSession(userId, networkId, channel, fresh, this.nowUnix());
    return fresh;
  }

  private effectiveMode(
    userId: number,
    networkId: number,
    handle: string,
    channel: string,
  ): keyring.ChannelMode | null {
    const cfg = keyring.getChannelConfig(userId, networkId, channel);
    if (!cfg || !cfg.enabled) return null;
    if (keyring.autotrustMatches(userId, networkId, handle, channel)) return 'auto-accept';
    return cfg.mode;
  }

  private classifyPeerChange(
    userId: number,
    networkId: number,
    fp: Uint8Array,
    handle: string,
  ): ClassifyResult {
    const byFp = keyring.getPeerByFingerprint(userId, networkId, fp);
    if (byFp && byFp.globalStatus === 'revoked') return 'revoked';
    const byHandle = keyring.getPeerByHandle(userId, networkId, handle);
    if (byHandle && !bytesEqual(byHandle.fingerprint, fp)) return 'fingerprint-changed';
    return byFp ? 'known' : 'new';
  }

  private upsertSeenPeer(
    userId: number,
    networkId: number,
    fp: Uint8Array,
    pubkey: Uint8Array,
    handle: string,
    nick: string | null,
  ): void {
    const now = this.nowUnix();
    keyring.upsertPeer(userId, networkId, {
      fingerprint: fp,
      pubkey,
      lastHandle: handle,
      lastNick: nick,
      firstSeen: now,
      lastSeen: now,
      globalStatus: 'pending', // only the insert uses this; conflicts preserve
    });
  }

  private hasTrustedIncoming(
    userId: number,
    networkId: number,
    handle: string,
    channel: string,
  ): boolean {
    const s = keyring.getIncomingSession(userId, networkId, handle, channel);
    return s?.status === 'trusted';
  }

  private inboundKey(userId: number, networkId: number, handle: string, channel: string): string {
    return `${userId}:${networkId}:${handle}:${channel}`;
  }

  private tofuWarning(handle: string, change: ClassifyResult): UserNotice {
    if (change === 'revoked') {
      return { level: 'warn', text: `Ignoring encrypted handshake from revoked peer ${handle}` };
    }
    return {
      level: 'warn',
      text: `⚠ encryption key changed for ${handle} — verify out-of-band, then /e2e reverify ${handle} to accept`,
    };
  }
}

/** Process-wide singleton used by the IRC layer. Tests construct their own
 *  instances (with an injected clock) to drive time-dependent paths. */
export const e2eManager = new E2eManager();
