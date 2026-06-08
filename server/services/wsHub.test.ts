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
let setClearedState: typeof import('../db/bufferReads.js').setClearedState;
let buildBufferBacklog: typeof import('./wsHub.js').buildBufferBacklog;
let buildResumeSlice: typeof import('./wsHub.js').buildResumeSlice;
let buildOfflineBacklogFrames: typeof import('./wsHub.js').buildOfflineBacklogFrames;
let handleOpenBuffer: typeof import('./wsHub.js').handleOpenBuffer;

let userId: number;
let networkId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ closeBuffer, isClosed } = await import('../db/closedBuffers.js'));
  ({ setClearedState } = await import('../db/bufferReads.js'));
  ({ buildBufferBacklog, buildResumeSlice, buildOfflineBacklogFrames, handleOpenBuffer } =
    await import('./wsHub.js'));

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

function seed(target: string, text: string): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text,
      self: false,
    }).id,
  );
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

  it('omits clear-state by default (no marker)', () => {
    seed('#noclear', 'just a message');
    const frame = buildBufferBacklog(userId, networkId, '#noclear');
    expect(frame.clearedBeforeId).toBe(0);
    expect(frame.clearedAt).toBeNull();
  });

  it('ships the /clear marker in the backlog so the client can restore the filter after a reconnect', () => {
    seed('#clear', 'one');
    seed('#clear', 'two');
    const beforeFrame = buildBufferBacklog(userId, networkId, '#clear');
    const boundary = (beforeFrame.events as Array<{ id: number }>).at(-1)!.id;
    const ts = '2026-05-27T12:00:00.000Z';
    setClearedState(userId, networkId, '#clear', boundary, ts);

    const frame = buildBufferBacklog(userId, networkId, '#clear');
    expect(frame.clearedBeforeId).toBe(boundary);
    expect(frame.clearedAt).toBe(ts);
  });
});

describe('buildResumeSlice', () => {
  // Mirrors the server-side constants in wsHub.ts. If those change, these move.
  const RESUME_GAP_CAP = 500;
  const RESUME_LATEST_LIMIT = 200;

  it('ships just the missed gap and does not reset when it fits the cap', () => {
    const since = seed('#resumeSmall', 'm0');
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push(seed('#resumeSmall', `m${i}`));
    const slice = buildResumeSlice(userId, networkId, '#resumeSmall', since);
    expect(slice.reset).toBe(false);
    expect(slice.events.length).toBe(5);
    // The gap, oldest-first — exactly the rows after the cursor.
    expect((slice.events[0] as { id: number }).id).toBe(ids[0]);
    expect((slice.events.at(-1) as { id: number }).id).toBe(ids.at(-1));
    // A non-reset frame doesn't drive hasMoreOlder (the client keeps its own).
    expect(slice.hasMoreOlder).toBe(false);
  });

  it('resets to the latest slice when the gap overflows the cap (issue #205)', () => {
    const since = seed('#resumeBig', 'm0');
    let lastId = since;
    // One more than the cap so the gap is provably truncated.
    for (let i = 1; i <= RESUME_GAP_CAP + 10; i++) lastId = seed('#resumeBig', `m${i}`);
    const slice = buildResumeSlice(userId, networkId, '#resumeBig', since);
    expect(slice.reset).toBe(true);
    // Latest contiguous slice, NOT the oldest-after-cursor rows.
    expect(slice.events.length).toBe(RESUME_LATEST_LIMIT);
    expect((slice.events.at(-1) as { id: number }).id).toBe(lastId);
    // There's older history beyond the latest slice — the client can page up.
    expect(slice.hasMoreOlder).toBe(true);
  });

  it('ships the latest slice without reset on first connect (sinceId=0)', () => {
    seed('#resumeFresh', 'a');
    seed('#resumeFresh', 'b');
    const slice = buildResumeSlice(userId, networkId, '#resumeFresh', 0);
    expect(slice.reset).toBe(false);
    expect(slice.events.length).toBe(2);
  });
});

describe('buildOfflineBacklogFrames', () => {
  // Tests run with no live IRC connection, so every network is "offline" — the
  // exact case a paused/disconnected user hits. Each test uses a fresh network
  // so it doesn't depend on history seeded by sibling tests.
  it('ships persisted buffers for a network with no live connection', () => {
    const net = createNetwork(userId, {
      name: 'offnet',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    const offId = net!.id;
    const seedOff = (target: string, text: string): void => {
      insertMessage({
        networkId: offId,
        target,
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text,
        self: false,
      });
    };
    seedOff('#offline', 'a');
    seedOff('#offline', 'b');
    seedOff('dave', 'dm');

    const byTarget = new Map(
      buildOfflineBacklogFrames(userId)
        .filter((f) => f.networkId === offId)
        .map((f) => [f.target as string, f]),
    );

    // Channel history is shipped, marked parted (no live connection tracks it).
    const chan = byTarget.get('#offline')!;
    expect(chan.kind).toBe('backlog');
    expect((chan.events as unknown[]).length).toBe(2);
    expect(chan.joined).toBe(false);
    // DM buffers have no join concept → reported joined so they never dim.
    expect(byTarget.get('dave')!.joined).toBe(true);
    // The uncloseable server pseudo-buffer is always present.
    expect(byTarget.has(`:server:${offId}`)).toBe(true);
  });

  it('skips a closed buffer but never the server pseudo-buffer', () => {
    const net = createNetwork(userId, {
      name: 'offnet2',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    const offId = net!.id;
    insertMessage({
      networkId: offId,
      target: '#hidden',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'x',
      self: false,
    });
    closeBuffer(userId, offId, '#hidden');

    const targets = buildOfflineBacklogFrames(userId)
      .filter((f) => f.networkId === offId)
      .map((f) => f.target);
    expect(targets).not.toContain('#hidden');
    expect(targets).toContain(`:server:${offId}`);
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
