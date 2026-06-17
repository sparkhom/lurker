// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// buffers.ts reaches into the networks/toasts stores and the socket. applyReadState
// only consults useNetworksStore().activeKey, so a minimal mutable mock covers it;
// toasts/socket are stubbed so importing the store doesn't stand up the rest of the
// graph.
const h = vi.hoisted(() => ({ activeKey: null as string | null }));

vi.mock('./networks.js', () => ({
  useNetworksStore: () => ({
    get activeKey() {
      return h.activeKey;
    },
  }),
}));
vi.mock('./toasts.js', () => ({ useToastsStore: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<(payload: unknown) => void>() }));

import { useBuffersStore } from './buffers.js';

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
});

describe('applyReadState', () => {
  // Regression for #319: mark-all-read fans out a read-state for every target
  // with history, including closed buffers (absent from the store). Applying
  // one must NOT materialize the buffer, or the closed buffer pops back into
  // the sidebar.
  it('does not create a buffer that is not open', () => {
    const store = useBuffersStore();
    expect(store.isOpen(1, '#closed')).toBe(false);

    store.applyReadState(1, '#closed', { lastReadId: 10, unread: 5, highlights: 2 });

    expect(store.isOpen(1, '#closed')).toBe(false);
    expect(store.list).toHaveLength(0);
  });

  it('updates the badge on an open buffer', () => {
    const store = useBuffersStore();
    // replaceBacklog ensures the buffer exists (the snapshot path), so this is
    // an "open" buffer.
    store.replaceBacklog(1, '#open', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#open')).toBe(true);

    store.applyReadState(1, '#open', { lastReadId: 42, unread: 3, highlights: 1 });

    const buf = store.byKey('1::#open')!;
    expect(buf.unread).toBe(3);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(42);
  });

  it('suppresses the unread badge for the active buffer', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#here', [], undefined, undefined, undefined);
    h.activeKey = '1::#here';

    store.applyReadState(1, '#here', { lastReadId: 42, unread: 9, highlights: 4 });

    const buf = store.byKey('1::#here')!;
    expect(buf.unread).toBe(0);
    expect(buf.highlighted).toBe(0);
  });

  // Servers hand us inconsistently-cased channel/nick names (#289). A read-state
  // broadcast whose target case differs from the buffer's stored key must still
  // resolve to the open buffer (findByTarget), not silently drop the badge or
  // fork a phantom lowercase entry.
  it('updates a buffer opened under a different target case', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#Chan', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#Chan')).toBe(true);

    store.applyReadState(1, '#chan', { lastReadId: 7, unread: 4, highlights: 1 });

    const buf = store.byKey('1::#Chan')!;
    expect(buf.unread).toBe(4);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(7);
    expect(store.isOpen(1, '#chan')).toBe(false); // no phantom lowercase fork
    expect(store.list).toHaveLength(1);
  });

  // While a buffer is active its unread divider is pinned (dividerAfterId set on
  // activate); a late read-state carrying a lower lastReadId must not slide the
  // divider backward out from under the reader (the Math.max branch).
  it('does not move lastReadId backwards while the divider is pinned', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#pinned', [], undefined, undefined, undefined);
    const buf = store.byKey('1::#pinned')!;
    buf.dividerAfterId = 100;
    buf.lastReadId = 50;

    store.applyReadState(1, '#pinned', { lastReadId: 30, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(50);

    store.applyReadState(1, '#pinned', { lastReadId: 70, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(70);
  });
});
