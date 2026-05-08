<template>
  <div v-if="segments.length" class="typing">
    <span class="who">
      <template v-for="(seg, i) in segments" :key="i"><span :style="seg.color ? { color: seg.color } : null">{{ seg.text }}</span></template>
    </span>
    <span class="dots"><span></span><span></span><span></span></span>
  </div>
  <div v-else class="typing empty"></div>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nickColors = useNickColors();

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));

const nicks = computed(() => {
  const t = buffer.value?.typing;
  if (!t) return [];
  return Object.keys(t);
});

function nickSeg(nick) {
  return { text: nick, color: nickColors.color(nick) };
}

const segments = computed(() => {
  const list = nicks.value;
  if (list.length === 0) return [];
  if (list.length === 1) {
    return [nickSeg(list[0]), { text: ' is typing' }];
  }
  if (list.length === 2) {
    return [nickSeg(list[0]), { text: ' and ' }, nickSeg(list[1]), { text: ' are typing' }];
  }
  if (list.length === 3) {
    return [nickSeg(list[0]), { text: ', ' }, nickSeg(list[1]), { text: ' and ' }, nickSeg(list[2]), { text: ' are typing' }];
  }
  return [nickSeg(list[0]), { text: ', ' }, nickSeg(list[1]), { text: ` and ${list.length - 2} others are typing` }];
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
