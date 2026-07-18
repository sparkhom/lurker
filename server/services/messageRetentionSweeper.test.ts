// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-retention-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let listMessages: typeof import('../db/messages.js').listMessages;
let deleteOlderThan: typeof import('../db/messages.js').deleteOlderThan;
let setMessageRetentionDays: typeof import('../db/instanceSettings.js').setMessageRetentionDays;
let sweepExpiredMessages: typeof import('./messageRetentionSweeper.js').sweepExpiredMessages;

beforeAll(async () => {
  await import('../db/index.js');
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage, listMessages, deleteOlderThan } = await import('../db/messages.js'));
  ({ setMessageRetentionDays } = await import('../db/instanceSettings.js'));
  ({ sweepExpiredMessages } = await import('./messageRetentionSweeper.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNetwork(nick: string): Network {
  const u = createUser(`retention-${nick}`);
  return createNetwork(u.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick,
  }) as Network;
}

describe('db/messages deleteOlderThan', () => {
  it('deletes rows older than the cutoff and leaves newer ones', async () => {
    const net = makeNetwork('batch');
    insertMessage({ networkId: net.id, target: '#t', time: '2020-01-01T00:00:00Z', type: 'message', text: 'old' });
    insertMessage({ networkId: net.id, target: '#t', time: '2030-01-01T00:00:00Z', type: 'message', text: 'new' });

    const removed = deleteOlderThan('2025-01-01T00:00:00Z');
    expect(removed).toBe(1);

    const remaining = listMessages(net.id, '#t');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('new');
  });

  it('batches across more rows than a single batch size', async () => {
    const net = makeNetwork('bulk');
    for (let i = 0; i < 25; i += 1) {
      insertMessage({
        networkId: net.id,
        target: '#bulk',
        time: '2020-01-01T00:00:00Z',
        type: 'message',
        text: `msg ${i}`,
      });
    }
    const removed = deleteOlderThan('2025-01-01T00:00:00Z', 10);
    expect(removed).toBe(25);
    expect(listMessages(net.id, '#bulk')).toHaveLength(0);
  });
});

describe('sweepExpiredMessages', () => {
  it('is a no-op when retention is unset', async () => {
    setMessageRetentionDays(null);
    const net = makeNetwork('unset');
    insertMessage({
      networkId: net.id,
      target: '#t',
      time: '2000-01-01T00:00:00Z',
      type: 'message',
      text: 'ancient',
    });
    expect(sweepExpiredMessages()).toBe(0);
    expect(listMessages(net.id, '#t')).toHaveLength(1);
  });

  it('deletes messages older than the configured window', async () => {
    const net = makeNetwork('configured');
    insertMessage({
      networkId: net.id,
      target: '#t',
      time: '2000-01-01T00:00:00Z',
      type: 'message',
      text: 'ancient',
    });
    insertMessage({
      networkId: net.id,
      target: '#t',
      time: new Date().toISOString(),
      type: 'message',
      text: 'fresh',
    });

    setMessageRetentionDays(30);
    // >= 1 rather than == 1: sweepExpiredMessages sweeps the whole table, not
    // just this network, so it also catches the earlier "unset" test's row
    // (unswept while retention was off). The per-network assertion below is
    // the one that actually pins down this test's behavior.
    const removed = sweepExpiredMessages();
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = listMessages(net.id, '#t');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('fresh');

    setMessageRetentionDays(null);
  });
});
