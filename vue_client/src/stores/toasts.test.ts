// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useToastsStore } from './toasts.js';

describe('toasts store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('threads an action callback through push so the toast can offer a CTA', () => {
    const toasts = useToastsStore();
    const onClick = vi.fn<() => void>();
    toasts.push({
      title: 'Invitation to #secret',
      body: 'alice invited you',
      kind: 'notify',
      action: { label: 'Join', onClick },
      ttlMs: 0,
    });
    const t = toasts.items[0];
    expect(t.action?.label).toBe('Join');
    t.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('omits action when none is given (plain toast)', () => {
    const toasts = useToastsStore();
    toasts.push({ title: 'hi', body: '', ttlMs: 0 });
    expect(toasts.items[0].action).toBeUndefined();
  });

  it('auto-dismisses after the ttl', () => {
    const toasts = useToastsStore();
    toasts.push({ title: 'hi', body: '', ttlMs: 5000 });
    expect(toasts.items.length).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(toasts.items.length).toBe(0);
  });
});
