// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

// setupTestDb sets DATABASE_PATH before any dynamic import touches db/index.js,
// so it must run at module top level.
const testDb = setupTestDb('wshub');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let closeBuffer: typeof import('../db/closedBuffers.js').closeBuffer;
let isClosed: typeof import('../db/closedBuffers.js').isClosed;
let buildBufferBacklog: typeof import('./wsHub.js').buildBufferBacklog;
let handleOpenBuffer: typeof import('./wsHub.js').handleOpenBuffer;

let userId: number;
let networkId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ closeBuffer, isClosed } = await import('../db/closedBuffers.js'));
  ({ buildBufferBacklog, handleOpenBuffer } = await import('./wsHub.js'));

  userId = createUser('alice').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  });
  networkId = net!.id;
});

afterAll(() => testDb.cleanup());

function seed(target: string, text: string): void {
  insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick: 'bob',
    text,
    self: false,
  });
}

// A WebSocket stand-in that records the frames send() writes. send() gates on
// `readyState === OPEN`, so the two must match for a frame to be captured.
function mockWs() {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { OPEN: 1, readyState: 1, send: (s: string) => frames.push(JSON.parse(s)) };
  return { ws: ws as unknown as Parameters<typeof handleOpenBuffer>[0], frames };
}

describe('buildBufferBacklog', () => {
  it('builds a backlog frame from a buffer’s persisted history', () => {
    seed('#bl', 'one');
    seed('#bl', 'two');
    seed('#bl', 'three');
    const frame = buildBufferBacklog(userId, networkId, '#bl');
    expect(frame.kind).toBe('backlog');
    expect(frame.networkId).toBe(networkId);
    expect(frame.target).toBe('#bl');
    expect((frame.events as unknown[]).length).toBe(3);
    // No live IRC connection in the test → the channel reads as parted.
    expect(frame.joined).toBe(false);
    expect(frame.unread).toBe(3);
    expect(frame.highlights).toBe(0);
  });

  it('reports a non-channel buffer (DM) as joined', () => {
    seed('carol', 'hi');
    expect(buildBufferBacklog(userId, networkId, 'carol').joined).toBe(true);
  });
});

describe('handleOpenBuffer', () => {
  it('reopens a since-closed channel without re-JOINing, resolving casing case-insensitively', () => {
    seed('#reopen', 'history line');
    closeBuffer(userId, networkId, '#reopen');
    expect(isClosed(userId, networkId, '#reopen')).toBe(true);

    // Clicked with different casing than the stored target.
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, '#ReOpen');

    // The closed flag is cleared — the buffer is reopened.
    expect(isClosed(userId, networkId, '#reopen')).toBe(false);
    // A backlog frame plus a buffer-opened frame, both keyed by the canonical
    // stored casing rather than the casing that was clicked.
    expect(frames.find((f) => f.kind === 'backlog')?.target).toBe('#reopen');
    expect(frames.find((f) => f.kind === 'buffer-opened')?.target).toBe('#reopen');
  });

  it('joins a channel with no history instead of reopening', () => {
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, '#never-visited');
    // No history → no backlog frame, just a buffer-opened for the clicked target.
    expect(frames.some((f) => f.kind === 'backlog')).toBe(false);
    expect(frames.find((f) => f.kind === 'buffer-opened')?.target).toBe('#never-visited');
  });

  it('ignores blank, zero-network, and server-buffer requests', () => {
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, ':server:1');
    handleOpenBuffer(ws, userId, networkId, '');
    handleOpenBuffer(ws, userId, 0, '#x');
    expect(frames).toHaveLength(0);
  });
});
