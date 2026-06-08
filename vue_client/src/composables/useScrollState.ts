// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
import { ref } from 'vue';

// Direction from the viewport to the pinned unread divider when it's off
// screen and not yet seen this visit: 'up' = above the viewport, 'down' =
// below it. null means there's nothing to jump to — no divider, it's on
// screen, or the user already scrolled it into view this visit.
export type UnreadAnchor = 'up' | 'down' | null;

// Bridges MessageList's scroll position into the StatusBar without a prop drill.
// MessageList writes via the setters; StatusBar reads the refs.
const stuckToBottom = ref(true);
const newBelow = ref(0);
const scrollToBottomToken = ref(0);
const unreadAnchor = ref<UnreadAnchor>(null);
const scrollToUnreadToken = ref(0);

export interface ScrollState {
  stuckToBottom: Ref<boolean>;
  newBelow: Ref<number>;
  scrollToBottomToken: Ref<number>;
  unreadAnchor: Ref<UnreadAnchor>;
  scrollToUnreadToken: Ref<number>;
}

export function useScrollState(): ScrollState {
  return { stuckToBottom, newBelow, scrollToBottomToken, unreadAnchor, scrollToUnreadToken };
}

export function setStuckToBottom(v: boolean): void {
  stuckToBottom.value = !!v;
  if (v) newBelow.value = 0;
}

export function bumpNewBelow(): void {
  if (!stuckToBottom.value) newBelow.value += 1;
}

export function resetScrollState(): void {
  stuckToBottom.value = true;
  newBelow.value = 0;
  unreadAnchor.value = null;
}

export function requestScrollToBottom(): void {
  scrollToBottomToken.value += 1;
}

export function setUnreadAnchor(dir: UnreadAnchor): void {
  unreadAnchor.value = dir;
}

export function requestScrollToUnread(): void {
  scrollToUnreadToken.value += 1;
}
