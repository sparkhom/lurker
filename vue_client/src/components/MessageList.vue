<template>
  <div ref="scroller" class="message-list" @scroll="onScroll">
    <div v-if="buffer?.loadingHistory" class="loading">loading older messages…</div>
    <div v-else-if="!buffer?.hasMore && messages.length" class="loading">— start of history —</div>
    <p v-if="!messages.length" class="empty">No messages yet.</p>
    <div v-for="(m, i) in messages" :key="m.id ?? `live:${i}`" class="line" :class="lineClass(m)">
      <span class="time">{{ time(m.time) }}</span>
      <span v-if="m.type === 'message'" class="nick" :class="{ self: m.self }">&lt;{{ m.nick }}&gt;</span>
      <span v-else-if="m.type === 'action'" class="nick action">* {{ m.nick }}</span>
      <span v-else-if="m.type === 'notice'" class="nick">-{{ m.nick }}-</span>
      <span v-else-if="m.type === 'join'" class="meta">→ {{ m.nick }} joined</span>
      <span v-else-if="m.type === 'part'" class="meta">← {{ m.nick }} left{{ m.text ? ' (' + m.text + ')' : '' }}</span>
      <span v-else-if="m.type === 'quit'" class="meta">⤫ {{ m.nick }} quit{{ m.text ? ' (' + m.text + ')' : '' }}</span>
      <span v-else-if="m.type === 'kick'" class="meta">⚠ {{ m.kicked }} kicked by {{ m.nick }}{{ m.text ? ' (' + m.text + ')' : '' }}</span>
      <span v-else-if="m.type === 'nick'" class="meta">{{ m.nick }} is now {{ m.newNick }}</span>
      <span v-else-if="m.type === 'topic'" class="meta">topic by {{ m.nick }}:</span>
      <span v-else-if="m.type === 'motd'" class="meta">[motd]</span>
      <span v-else-if="m.type === 'error'" class="meta error">[error]</span>
      <span class="text">{{ m.text }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { socketSend } from '../composables/useSocket.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();

const scroller = ref(null);
const stickToBottom = ref(true);

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const messages = computed(() => buffer.value?.messages || []);

function time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function lineClass(m) {
  return {
    [`type-${m.type}`]: true,
    self: m.self,
  };
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

let preloadHeight = 0;
watch(messages, async (newVal, oldVal) => {
  const el = scroller.value;
  const grew = newVal.length > (oldVal?.length || 0);
  const prepended = newVal.length && oldVal?.length && newVal[0]?.id !== oldVal[0]?.id;
  if (prepended && el) {
    preloadHeight = el.scrollHeight;
    await nextTick();
    el.scrollTop = el.scrollHeight - preloadHeight + el.scrollTop;
    return;
  }
  await nextTick();
  if (stickToBottom.value && grew) scrollToBottom();
}, { deep: false });

watch(() => networks.activeKey, async () => {
  stickToBottom.value = true;
  await nextTick();
  scrollToBottom();
});
</script>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
}
.line {
  display: grid;
  grid-template-columns: 50px max-content 1fr;
  gap: 8px;
  padding: 1px 0;
}
.line:hover { background: var(--bg-alt); }
.time { color: var(--fg-muted); font-size: 12px; }
.loading {
  text-align: center;
  color: var(--fg-muted);
  font-size: 11px;
  padding: 6px 0;
  font-style: italic;
}
.nick { color: var(--accent); }
.nick.self { color: var(--good); }
.nick.action { color: var(--warn); font-style: italic; }
.meta { color: var(--fg-muted); font-style: italic; }
.meta.error { color: var(--bad); }
.text { white-space: pre-wrap; word-break: break-word; }
.empty { color: var(--fg-muted); font-style: italic; padding: 8px 0; }
</style>
