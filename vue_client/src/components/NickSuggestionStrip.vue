<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <div
    class="nick-suggestion-strip"
    :class="{ visible: rows.length > 0 }"
    @pointerdown.stop
    @mousedown.prevent.stop
  >
    <!-- iOS keyboard preservation:
         - Fire the action on `click` (end of the touch sequence). Emitting on
           pointerdown closes the strip (v-show → display:none) *mid-touch*, so
           the subsequent mousedown lands on whatever's underneath (StatusBar)
           instead of this chip — defeating @mousedown.prevent and dismissing
           the soft keyboard.
         - @mousedown.prevent is the canonical iOS hook that prevents the
           browser from shifting focus away from the textarea on tap. It must
           fire on the chip itself, which is why the action moved to click.
         - Plain <div>, not <button>: a <button> is focusable, so iOS would
           still steal focus during the touch before mousedown.prevent runs. -->
    <div
      v-for="row in rows"
      :key="row.lc"
      role="button"
      class="chip"
      :style="row.color ? { color: row.color } : null"
      @mousedown.prevent
      @click="emit('select', row.nick)"
    >{{ row.nick }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { buildNickCandidates } from '../utils/nickCompletion.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNickColors } from '../composables/useNickColors.js';

const props = defineProps({
  query: { type: String, default: '' },
  buffer: { type: Object, default: null },
  selfNick: { type: String, default: '' },
});

const emit = defineEmits(['select']);

const ignores = useIgnoresStore();
const nickColors = useNickColors();

const rows = computed(() => {
  if (!props.query) return [];
  const networkId = props.buffer?.networkId;
  const isIgnored = networkId
    ? (nick, userhost) => ignores.isIgnored(networkId, nick, userhost)
    : null;
  return buildNickCandidates(props.buffer, props.selfNick, props.query, isIgnored)
    .slice(0, 30)
    .map((c) => ({
      nick: c.nick,
      lc: c.nick.toLowerCase(),
      color: nickColors.color(c.nick),
    }));
});
</script>

<style scoped>
/* Mirrors StatusBar's row so this strip reads as the same chrome with its
   contents swapped — same padding, same border-top, same background as the
   shell so it cleanly covers the bar underneath. */
.nick-suggestion-strip {
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
.nick-suggestion-strip::-webkit-scrollbar { display: none; }
.nick-suggestion-strip.visible {
  opacity: 1;
  pointer-events: auto;
}
.chip {
  flex: 0 0 auto;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  /* Disables the iOS double-tap-zoom heuristic, which can otherwise insert a
     ~300ms delay before click fires — long enough for an impatient user to
     have already tapped again or for layout to shift under the touch. */
  touch-action: manipulation;
}
</style>
