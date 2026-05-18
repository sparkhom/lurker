// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

export function useActiveBuffer() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const { activeKey } = storeToRefs(networks);

  const active = computed(() => networks.activeBuffer);
  const isSystemConsole = computed(() => activeKey.value === ':system:');
  const activeBuf = computed(() => {
    if (!activeKey.value || isSystemConsole.value) return null;
    return buffers.byKey(activeKey.value);
  });
  const topic = computed(() => activeBuf.value?.topic);
  const isServerBuffer = computed(
    () => !!active.value?.target?.startsWith(':server:')
  );
  const isChannel = computed(() => !!active.value?.target?.startsWith('#'));
  const bufferLabel = computed(() => {
    const t = active.value?.target;
    if (!t) return '';
    if (isServerBuffer.value) return active.value?.network?.name || 'server';
    return t;
  });

  return { activeKey, active, activeBuf, topic, isServerBuffer, isChannel, bufferLabel, isSystemConsole };
}
