<template>
  <div ref="scroller" class="message-list" @scroll="onScroll">
    <div v-if="buffer?.loadingHistory" class="notice">loading older messages…</div>
    <div v-else-if="!buffer?.hasMore && messages.length" class="notice">— start of history —</div>
    <p v-if="!messages.length" class="notice empty">No messages yet.</p>
    <div
      v-for="(m, i) in messages"
      :key="m.id ?? `live:${i}`"
      class="line"
      :class="lineClass(m)"
    >
      <span class="time">{{ time(m.time) }}</span>
      <span class="prefix" :class="prefixClass(m)" :style="prefixStyle(m)">{{ prefixText(m) }}</span>
      <span class="body" :class="bodyClass(m)">
        <template v-if="hasInlineText(m)">
          <template v-for="(seg, j) in textSegments(m)" :key="j">
            <span v-if="seg.color" :style="{ color: seg.color }">{{ seg.text }}</span>
            <span v-else-if="seg.self" :style="{ color: selfColor }">{{ seg.text }}</span>
            <template v-else>{{ seg.text }}</template>
          </template>
        </template>
        <template v-else-if="m.type === 'join'"><NickRef :nick="m.nick" /> joined</template>
        <template v-else-if="m.type === 'part'"><NickRef :nick="m.nick" /> left<template v-if="m.text"> ({{ m.text }})</template></template>
        <template v-else-if="m.type === 'quit'"><NickRef :nick="m.nick" /> quit<template v-if="m.text"> ({{ m.text }})</template></template>
        <template v-else-if="m.type === 'kick'"><NickRef :nick="m.kicked" /> kicked by <NickRef :nick="m.nick" /><template v-if="m.text"> ({{ m.text }})</template></template>
        <template v-else-if="m.type === 'nick'"><NickRef :nick="m.nick" /> is now <NickRef :nick="m.newNick" /></template>
        <template v-else-if="m.type === 'mode'">mode by <NickRef :nick="m.nick" />{{ m.text ? ': ' + m.text : '' }}</template>
        <template v-else-if="m.type === 'topic'">topic set by <NickRef :nick="m.nick" /><template v-if="m.text">: {{ m.text }}</template></template>
        <template v-else-if="m.type === 'motd'">{{ m.text }}</template>
        <template v-else-if="m.type === 'error'">{{ m.text }}</template>
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { socketSend } from '../composables/useSocket.js';
import { useNickColors } from '../composables/useNickColors.js';
import { formatTimestamp } from '../utils/timestamp.js';
import NickRef from './NickRef.vue';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const nicks = useNickColors();

const actionItalic = computed(() => !!settings.effective('look.action.italic'));
const selfColor = computed(() => settings.effective('look.nick.self_color'));
const tsFormat = computed(() => settings.effective('look.buffer.time_format'));

const scroller = ref(null);
const stickToBottom = ref(true);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const messages = computed(() => buffer.value?.messages || []);

const selfLower = computed(() => {
  const b = buffer.value;
  const sn = b ? networks.states[b.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const nickSet = computed(() => {
  const b = buffer.value;
  const set = new Set();
  if (!b) return set;
  for (const mem of (b.members || [])) {
    const n = typeof mem === 'string' ? mem : mem.nick;
    if (n) set.add(n);
  }
  if (b.target && !b.target.startsWith('#') && !b.target.startsWith(':server:')) {
    set.add(b.target);
  }
  const sn = networks.states[b.networkId]?.nick;
  if (sn) set.add(sn);
  return set;
});

function time(iso) {
  return formatTimestamp(iso, tsFormat.value);
}

function lineClass(m) {
  return {
    [`type-${m.type}`]: true,
    self: m.self,
  };
}

// What goes in column 2. For chat lines this is the nick (right-aligned);
// for system events it's a tiny indicator glyph (-->, <--, --, !!).
function prefixText(m) {
  switch (m.type) {
    case 'message': return m.nick;
    case 'action':  return '*';
    case 'notice':  return `-${m.nick}-`;
    case 'join':    return '-->';
    case 'part':
    case 'quit':
    case 'kick':    return '<--';
    case 'nick':
    case 'mode':
    case 'topic':
    case 'motd':    return '--';
    case 'error':   return '!!';
    default:        return '';
  }
}

function prefixClass(m) {
  return {
    nick: m.type === 'message' || m.type === 'notice',
    'action-marker': m.type === 'action',
    italic: m.type === 'action' && actionItalic.value,
    self: m.self,
    [`p-${m.type}`]: true,
  };
}

function prefixStyle(m) {
  if (m.type === 'message' || m.type === 'notice') {
    if (m.self) return { color: selfColor.value };
    const c = nicks.color(m.nick);
    return c ? { color: c } : null;
  }
  return null;
}

function bodyClass(m) {
  return {
    italic: m.type === 'action' && actionItalic.value,
    'meta-body': m.type !== 'message' && m.type !== 'action' && m.type !== 'notice',
  };
}

// True for any line type whose body is just `m.text` and should be split
// through the nick-coloring helper. Action lines render their author's nick
// at the start of the body, with `m.text` after.
function hasInlineText(m) {
  return m.type === 'message' || m.type === 'notice' || m.type === 'action';
}

function textSegments(m) {
  if (m.type === 'action') {
    // Body is "<nick> <text>" — author's nick then the action text.
    return nicks.splitText(`${m.nick} ${m.text || ''}`, nickSet.value, selfLower.value);
  }
  return nicks.splitText(m.text || '', nickSet.value, selfLower.value);
}

function maybeRequestHistory() {
  const buf = buffer.value;
  const el = scroller.value;
  if (!buf || !el) return;
  if (!buf.hasMore || buf.loadingHistory) return;
  if (el.scrollTop > 80) return;
  if (buf.target.startsWith(':server:')) return;

  buffers.setLoadingHistory(buf.networkId, buf.target, true);
  const before = buf.oldestId ?? buf.messages[0]?.id;
  socketSend({
    type: 'history',
    networkId: buf.networkId,
    target: buf.target,
    before,
    limit: 100,
  });
}

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  maybeRequestHistory();
}

function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// Watch length, first-id, and last-id. pushMessage mutates the array via
// .push(), which a `watch(messages)` with deep:false would never see — Vue
// only re-evaluates when a tracked dep changes, and push() doesn't change
// the array's reference. Tracking length covers live pushes; tracking
// first/last ids lets us tell a prepend (older history loaded on top) from
// a wholesale replace (fresh backlog after a re-snapshot), which need
// opposite scroll behavior.
let preloadHeight = 0;
watch(
  [
    () => messages.value.length,
    () => messages.value[0]?.id,
    () => messages.value[messages.value.length - 1]?.id,
  ],
  async ([newLen, newFirstId, newLastId], [oldLen, oldFirstId, oldLastId]) => {
    const el = scroller.value;
    if (!el) return;
    const prevLen = oldLen || 0;
    const grew = newLen > prevLen;
    const firstChanged = prevLen > 0 && newFirstId !== oldFirstId;
    const lastChanged = prevLen > 0 && newLastId !== oldLastId;
    // Pure prepend: older messages stitched on top, newest tail unchanged.
    // Preserve the user's scroll position relative to the previous content.
    if (firstChanged && !lastChanged && grew) {
      preloadHeight = el.scrollHeight;
      await nextTick();
      el.scrollTop = el.scrollHeight - preloadHeight + el.scrollTop;
      return;
    }
    // Wholesale replace (fresh backlog from a re-snapshot): both ends shifted.
    // Snap to bottom regardless of prior scroll position so the user sees
    // current state instead of a random offset into the new content.
    const replaced = firstChanged && lastChanged;
    await nextTick();
    if (replaced) {
      stickToBottom.value = true;
      scrollToBottom();
      return;
    }
    if (stickToBottom.value && grew) scrollToBottom();
  },
);

watch(() => networks.activeKey, async () => {
  stickToBottom.value = true;
  await nextTick();
  scrollToBottom();
});
</script>

<style scoped>
/* WeeChat-style 3-column layout: time | nick | body, with column 2 sized to
   the widest nick currently visible. Each .line is a subgrid row, so the
   columns line up across every message in the pane.

   Gaps come from per-cell padding (column-gap is 0) so we can put a thin
   vertical separator centered between the nick and body columns. */
.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 12px;
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr);
  grid-auto-rows: min-content;
  align-content: start;
  column-gap: 0;
  row-gap: 0;
  line-height: 1.45;
}

.line {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
}
.line:hover { background: var(--bg-soft); }

.time {
  color: var(--fg-muted);
  padding-right: 1ch;
}

.prefix {
  justify-self: end;
  white-space: nowrap;
  padding-right: 1ch;
}
.prefix.italic { font-style: italic; }
.prefix.action-marker { color: var(--fg-muted); }
.prefix.p-join  { color: var(--good); }
.prefix.p-part,
.prefix.p-quit  { color: var(--fg-muted); }
.prefix.p-kick,
.prefix.p-error { color: var(--bad); }
.prefix.p-nick,
.prefix.p-mode,
.prefix.p-topic,
.prefix.p-motd  { color: var(--fg-muted); }

.body {
  position: relative;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  padding-left: 1ch;
}
/* Vertical separator between the nick and body columns. Drawn from .body
   so it stretches the full height of the body cell — including wrapped
   lines — rather than just the nick's single-line box. */
.body::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--border);
}
.body.meta-body { color: var(--fg-muted); font-style: italic; }
.body.italic { font-style: italic; }

.notice {
  grid-column: 1 / -1;
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: 6px 0;
  margin: 0;
}
</style>
