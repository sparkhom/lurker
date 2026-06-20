<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <span class="nick-ref" :style="style">{{ nick }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickColors } from '../composables/useNickColors.js';

const props = defineProps<{
  nick: string;
}>();

const networks = useNetworksStore();
const buffers = useBuffersStore();
const nicks = useNickColors();

const selfLower = computed(() => {
  const key = networks.activeKey;
  if (!key) return null;
  const buf = buffers.byKey(key);
  const sn = buf && buf.networkId != null ? networks.states[buf.networkId]?.nick : null;
  return sn ? sn.toLowerCase() : null;
});

const isSelf = computed(() => {
  const sl = selfLower.value;
  return !!(sl && props.nick && props.nick.toLowerCase() === sl);
});

const style = computed(() => {
  if (isSelf.value) return { color: nicks.selfColor.value };
  const c = nicks.color(props.nick);
  return c ? { color: c } : null;
});
</script>

<style scoped>
.nick-ref {
  color: inherit;
}
</style>
