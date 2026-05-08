<template>
  <div class="members">
    <header>
      <span>Members</span>
      <span class="count">{{ members.length }}</span>
    </header>
    <ul>
      <li v-for="m in sorted" :key="nickOf(m)" :class="prefixClass(m)">
        <span class="prefix">{{ prefixOf(m) }}</span>
        <span class="nick" :style="nickStyle(m)">{{ nickOf(m) }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();

const buffer = computed(() => (networks.activeKey ? buffers.byKey(networks.activeKey) : null));
const members = computed(() => buffer.value?.members || []);
const selfNick = computed(() => {
  const b = buffer.value;
  if (!b) return null;
  return networks.states[b.networkId]?.nick || null;
});

function isSelf(m) {
  const sn = selfNick.value;
  return !!sn && nickOf(m).toLowerCase() === sn.toLowerCase();
}
function nickStyle(m) {
  if (isSelf(m)) return { color: nicks.selfColor.value };
  const c = nicks.color(nickOf(m));
  return c ? { color: c } : null;
}

const PREFIX_ORDER = ['~', '&', '@', '%', '+', ''];

function nickOf(m) { return typeof m === 'string' ? m : m.nick; }
function modesOf(m) { return Array.isArray(m?.modes) ? m.modes : []; }
function prefixOf(m) {
  const modes = modesOf(m);
  if (modes.includes('q')) return '~';
  if (modes.includes('a')) return '&';
  if (modes.includes('o')) return '@';
  if (modes.includes('h')) return '%';
  if (modes.includes('v')) return '+';
  return '';
}
function prefixClass(m) {
  const p = prefixOf(m);
  return p ? `mode-${p}` : '';
}

const sorted = computed(() => [...members.value].sort((a, b) => {
  const pa = PREFIX_ORDER.indexOf(prefixOf(a));
  const pb = PREFIX_ORDER.indexOf(prefixOf(b));
  if (pa !== pb) return pa - pb;
  return nickOf(a).localeCompare(nickOf(b), undefined, { sensitivity: 'base' });
}));
</script>

<style scoped>
.members { display: flex; flex-direction: column; height: 100%; }
header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: flex;
  justify-content: space-between;
}
ul { list-style: none; margin: 0; padding: 6px 0; overflow: auto; }
li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 12px;
  font-size: 13px;
}
.prefix { width: 12px; color: var(--fg-muted); }
li.mode-\@ .prefix, li.mode-\~ .prefix, li.mode-\& .prefix { color: var(--accent); }
li.mode-\+ .prefix { color: var(--good); }
.nick { font-family: var(--mono); color: var(--accent); }
</style>
