<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Generic horizontal suggestion strip that floats over the StatusBar — the
  IRCCloud-style autocomplete bar. Visually it mirrors NickSuggestionStrip
  (same chrome as the bar it covers); behaviourally it adds keyboard
  navigation, exposing the same `moveActive` / `confirmActive` /
  `hasCandidates` interface as the desktop NickPicker so a host's textarea
  keydown handler can drive it.

  The strip is content-agnostic: callers pass an `items` array and a `keyFor`
  function, and render each chip's body through the `chip` slot. The emoji
  suggester is the first consumer; NickSuggestionStrip could later adopt it.
-->

<template>
  <div
    ref="rootEl"
    class="suggestion-strip"
    :class="{ visible: items.length > 0 }"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- iOS keyboard preservation, same rationale as NickSuggestionStrip:
         fire on `click` (end of touch), keep `@mousedown.prevent` on the chip
         so focus never leaves the textarea, and use a plain <div role=button>
         rather than a focusable <button>. -->
    <div
      v-for="(item, i) in items"
      :key="keyFor(item)"
      role="button"
      class="chip"
      :class="{ active: i === activeIndex }"
      @mousedown.prevent
      @click="emit('select', item)"
      @mouseenter="activeIndex = i"
    >
      <slot name="chip" :item="item" />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T">
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{
  items: T[];
  /** Stable :key for each item — the strip is content-agnostic. */
  keyFor: (item: T) => string;
}>();

const emit = defineEmits<{
  select: [item: T];
}>();

// The highlighted chip. Keyboard nav (driven by the host's keydown handler)
// walks this; hovering a chip with the mouse adopts it too, so the two input
// modes share one highlight and can't disagree.
const activeIndex = ref(0);
const rootEl = ref<HTMLElement | null>(null);

// A changed candidate set restarts the highlight at the first chip: a fresh
// query shouldn't inherit a stale position, and a shrunk list shouldn't
// strand the index past the end.
watch(
  () => props.items,
  () => {
    activeIndex.value = 0;
  },
);

// `delta` is in chip-index space — +1 steps to the next chip, -1 to the
// previous — and wraps at both ends so a held arrow cycles the whole row.
function moveActive(delta: number): void {
  const n = props.items.length;
  if (n === 0) return;
  activeIndex.value = (activeIndex.value + delta + n) % n;
  // The strip scrolls horizontally once the candidates overflow; pull a
  // keyboard-selected chip back into view.
  nextTick(() => {
    rootEl.value
      ?.querySelector('.chip.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function confirmActive(): void {
  const item = props.items[activeIndex.value];
  if (item !== undefined) emit('select', item);
}

function hasCandidates(): boolean {
  return props.items.length > 0;
}

defineExpose({ moveActive, confirmActive, hasCandidates });
</script>

<style scoped>
/* Mirrors NickSuggestionStrip / StatusBar — same padding, border-top and
   background as the shell, so it cleanly covers the bar underneath. */
.suggestion-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 1ch 12px 0;
  background: var(--bg);
  border-top: 1px solid var(--border);
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  z-index: 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 80ms linear;
}
.suggestion-strip::-webkit-scrollbar {
  display: none;
}
.suggestion-strip.visible {
  opacity: 1;
  pointer-events: auto;
}
.chip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5ch;
  background: none;
  border: none;
  padding: 2px 6px;
  font: inherit;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  /* Disables the iOS double-tap-zoom heuristic and its ~300ms click delay. */
  touch-action: manipulation;
}
/* Highlight matches a selected buffer row in the buffer list — a flat
   --bg-soft fill with square edges — so the suggester reads as the same kind
   of selection affordance used elsewhere. Single rule shared by mouse and
   keyboard: hovering sets activeIndex (see @mouseenter), so `.active` alone
   covers both with no separate :hover rule that could double-highlight during
   keyboard nav. */
.chip.active {
  background: var(--bg-soft);
}
</style>
