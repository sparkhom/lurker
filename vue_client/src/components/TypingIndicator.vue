<template>
  <div v-if="text" class="typing">
    <span class="who">{{ text }}</span>
    <span class="dots"><span></span><span></span><span></span></span>
  </div>
  <div v-else class="typing empty"></div>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

const nicks = computed(() => {
  const t = buffer.value?.typing;
  if (!t) return [];
  return Object.keys(t);
});

const text = computed(() => {
  const list = nicks.value;
  if (list.length === 0) return '';
  if (list.length === 1) return `${list[0]} is typing`;
  if (list.length === 2) return `${list[0]} and ${list[1]} are typing`;
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]} are typing`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} others are typing`;
});
</script>

<style scoped>
.typing {
  height: 18px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
}
.typing.empty { padding: 0; }

.dots { display: inline-flex; gap: 2px; }
.dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fg-muted);
  animation: typing-blink 1.4s infinite both;
}
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-blink {
  0%, 60%, 100% { opacity: 0.2; }
  30% { opacity: 1; }
}
</style>
