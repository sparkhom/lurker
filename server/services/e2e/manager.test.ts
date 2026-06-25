// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate the DB at a throwaway file before any db-touching module loads. No
// LURKER_SECRET_KEY is set — the keyring's sealing is a no-op passthrough, which
// the manager doesn't care about (it gets the same bytes back) and which keeps
// this file from leaking that env var into other test files.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-e2e-manager-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let mod: typeof import('./manager.js');
let createUser: typeof import('../../db/users.js').createUser;
let createNetwork: typeof import('../../db/networks.js').createNetwork;

// Two Lurker accounts standing in for the two ends of an encrypted conversation.
let alice: number;
let bob: number;
let aliceNet: number;
let bobNet: number;
const ALICE_H = '~alice@a.host';
const BOB_H = '~bob@b.host';

let clock: number;
let mgr: import('./manager.js').E2eManager;

beforeAll(async () => {
  mod = await import('./manager.js');
  ({ createUser } = await import('../../db/users.js'));
  ({ createNetwork } = await import('../../db/networks.js'));
  alice = createUser('mgr-alice').id;
  bob = createUser('mgr-bob').id;
  const mkNet = (uid: number) =>
    createNetwork(uid, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'n' })!.id;
  aliceNet = mkNet(alice);
  bobNet = mkNet(bob);
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  clock = 1_700_000_000_000;
  mgr = new mod.E2eManager({ now: () => clock });
});

// Drive a full bidirectional handshake on `channel` (auto-accept both ends).
function fullHandshake(channel: string): void {
  mgr.setChannelConfig(alice, aliceNet, channel, true, 'auto-accept');
  mgr.setChannelConfig(bob, bobNet, channel, true, 'auto-accept');
  // Bob → KEYREQ; Alice → KEYRSP + reciprocal KEYREQ.
  const req = mgr.buildKeyReq(bob, bobNet, channel);
  const aOut = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
  expect(aOut.replies).toHaveLength(2);
  mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[0]); // KEYRSP → Bob installs Alice's key
  const bOut = mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', aOut.replies[1])!; // reciprocal
  expect(bOut.replies).toHaveLength(1); // Bob already trusts Alice → no further reciprocal
  mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', bOut.replies[0]); // KEYRSP → Alice installs Bob's key
}

describe('E2eManager handshake + exchange', () => {
  it('completes a full handshake and exchanges encrypted messages both ways', () => {
    fullHandshake('#x');

    const aToB = mgr.encryptOutgoing(alice, aliceNet, '#x', 'hello bob')!;
    expect(aToB).toHaveLength(1);
    expect(aToB[0].startsWith('+RPE2E01')).toBe(true);
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#x', aToB[0])).toEqual({
      kind: 'plaintext',
      text: 'hello bob',
    });

    const bToA = mgr.encryptOutgoing(bob, bobNet, '#x', 'hi alice 👋')!;
    expect(mgr.decryptIncoming(alice, aliceNet, BOB_H, '#x', bToA[0])).toEqual({
      kind: 'plaintext',
      text: 'hi alice 👋',
    });
  });

  it('chunks a long message and decrypts every chunk', () => {
    fullHandshake('#big');
    const long = 'x'.repeat(500);
    const lines = mgr.encryptOutgoing(alice, aliceNet, '#big', long)!;
    expect(lines.length).toBeGreaterThan(1);
    const decoded = lines.map((l) => {
      const out = mgr.decryptIncoming(bob, bobNet, ALICE_H, '#big', l);
      return out.kind === 'plaintext' ? out.text : `<${out.kind}>`;
    });
    expect(decoded.join('')).toBe(long);
  });

  it('returns null from encryptOutgoing when the channel is not enabled', () => {
    expect(mgr.encryptOutgoing(alice, aliceNet, '#off', 'secret')).toBeNull();
  });

  it('passes a non-RPE2E line through as cleartext', () => {
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#x', 'just a normal line')).toEqual({
      kind: 'cleartext',
      text: 'just a normal line',
    });
  });

  it('reports missing-key when no session exists for the sender', () => {
    fullHandshake('#mk');
    const line = mgr.encryptOutgoing(alice, aliceNet, '#mk', 'hi')![0];
    // Bob has a session for ALICE_H, but not for a different handle.
    expect(mgr.decryptIncoming(bob, bobNet, '~stranger@h', '#mk', line)).toEqual({
      kind: 'missing-key',
    });
  });
});

describe('E2eManager trust modes', () => {
  it('normal mode caches the KEYREQ and accepts on demand', () => {
    mgr.setChannelConfig(alice, aliceNet, '#nrm', true, 'normal');
    mgr.setChannelConfig(bob, bobNet, '#nrm', true, 'auto-accept');

    const req = mgr.buildKeyReq(bob, bobNet, '#nrm');
    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
    expect(out.replies).toHaveLength(0); // no auto-response in normal mode
    expect(out.notice?.text).toMatch(/wants to start an encrypted session/);

    // Alice accepts → now she emits the KEYRSP (+ reciprocal).
    const accepted = mgr.acceptPending(alice, aliceNet, BOB_H, '#nrm');
    expect(accepted.replies.length).toBeGreaterThanOrEqual(1);
    mgr.handleHandshakeBody(bob, bobNet, ALICE_H, 'alice', accepted.replies[0]); // Bob installs Alice's key

    const line = mgr.encryptOutgoing(alice, aliceNet, '#nrm', 'now secured')![0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#nrm', line)).toEqual({
      kind: 'plaintext',
      text: 'now secured',
    });
  });

  it('quiet mode silently ignores an unknown peer', () => {
    mgr.setChannelConfig(alice, aliceNet, '#qt', true, 'quiet');
    const req = mgr.buildKeyReq(bob, bobNet, '#qt');
    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', req)!;
    expect(out.replies).toHaveLength(0);
    expect(out.notice).toBeUndefined();
  });
});

describe('E2eManager TOFU + replay + window', () => {
  it('warns and refuses when a pinned handle presents a new fingerprint', () => {
    fullHandshake('#tofu'); // pins Bob's fp under BOB_H for Alice
    // A third identity (mallory) sends a KEYREQ impersonating BOB_H.
    const mallory = createUser('mgr-mallory').id;
    const malloryNet = createNetwork(mallory, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'm',
    })!.id;
    mgr.setChannelConfig(mallory, malloryNet, '#tofu', true, 'auto-accept');
    const impostorReq = mgr.buildKeyReq(mallory, malloryNet, '#tofu');

    const out = mgr.handleHandshakeBody(alice, aliceNet, BOB_H, 'bob', impostorReq)!;
    expect(out.replies).toHaveLength(0); // refused
    expect(out.notice?.level).toBe('warn');
    expect(out.notice?.text).toMatch(/key changed/);
  });

  it('flags a replayed chunk', () => {
    fullHandshake('#rp');
    const line = mgr.encryptOutgoing(alice, aliceNet, '#rp', 'once')![0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rp', line)).toEqual({
      kind: 'plaintext',
      text: 'once',
    });
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rp', line)).toEqual({ kind: 'replay' });
  });

  it('rejects a chunk whose ts is outside the tolerance window', () => {
    fullHandshake('#win');
    const line = mgr.encryptOutgoing(alice, aliceNet, '#win', 'stale')![0];
    clock += 1000 * 1000; // advance 1000s, well past the 300s default tolerance
    const out = mgr.decryptIncoming(bob, bobNet, ALICE_H, '#win', line);
    expect(out.kind).toBe('rejected');
  });
});

describe('E2eManager identity + verify', () => {
  it('returns a stable per-account identity with a 6-word SAS', () => {
    const a1 = mgr.getIdentity(alice);
    const a2 = new mod.E2eManager({ now: () => clock }).getIdentity(alice); // reload from DB
    expect(a2.fingerprintHex).toBe(a1.fingerprintHex);
    expect(a1.sas.split(' ')).toHaveLength(6);
    // Different account → different identity.
    expect(mgr.getIdentity(bob).fingerprintHex).not.toBe(a1.fingerprintHex);
  });

  it('verifyInfo returns the peer fingerprint after a handshake', () => {
    fullHandshake('#vf');
    const info = mgr.verifyInfo(alice, aliceNet, BOB_H)!;
    expect(info.fingerprintHex).toBe(mgr.getIdentity(bob).fingerprintHex);
    expect(info.status).toBe('trusted');
  });

  it('revoke stops decryption; reverify clears the pin', () => {
    fullHandshake('#rv');
    const line = mgr.encryptOutgoing(alice, aliceNet, '#rv', 'pre-revoke')![0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line).kind).toBe('plaintext');

    expect(mgr.revokePeer(bob, bobNet, ALICE_H)).toBe(true);
    const line2 = mgr.encryptOutgoing(alice, aliceNet, '#rv', 'post-revoke')![0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line2).kind).toBe('rejected');

    expect(mgr.reverifyPeer(bob, bobNet, ALICE_H)).toBeGreaterThan(0);
    // After reverify the session is gone entirely.
    const line3 = mgr.encryptOutgoing(alice, aliceNet, '#rv', 'after-reverify')![0];
    expect(mgr.decryptIncoming(bob, bobNet, ALICE_H, '#rv', line3)).toEqual({
      kind: 'missing-key',
    });
  });
});
