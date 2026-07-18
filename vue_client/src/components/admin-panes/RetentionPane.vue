<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<!--
  Admin: how long chat history sticks around. A single instance-wide knob —
  days to keep, or "forever" (the default, so nobody's history silently starts
  disappearing on upgrade). Enforcement is services/messageRetentionSweeper,
  an hourly sweep that deletes messages older than the window.
-->

<template>
  <section class="settings-pane">
    <h2>Retention</h2>
    <p class="section-desc">
      How long chat history is kept before it's deleted. Applies to every network and every user
      on this instance. Off by default — history is kept forever until you set a window.
    </p>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <form class="add" @submit.prevent="save">
      <label class="check">
        <input type="checkbox" v-model="enabled" :disabled="busy" />
        <span>Automatically delete messages after a set number of days</span>
      </label>
      <label v-if="enabled">
        <span>Days to keep</span>
        <input v-model.number="days" type="number" min="1" step="1" :disabled="busy" required />
      </label>
      <button type="submit" class="btn-primary" :disabled="busy">Save</button>
    </form>

    <p class="muted small">
      Currently:
      <strong v-if="store.messageRetentionDays">
        messages older than {{ store.messageRetentionDays }} day{{
          store.messageRetentionDays === 1 ? '' : 's'
        }}
        are deleted.
      </strong>
      <strong v-else>history is kept forever.</strong>
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useAdminStore } from '../../stores/admin.js';

const store = useAdminStore();
const busy = ref(false);
const enabled = ref(false);
const days = ref(90);

onMounted(async () => {
  if (!store.retentionLoaded) {
    await store.fetchRetention().catch(() => {});
  }
  syncFromStore();
});

// Re-sync the draft fields whenever the store's truth changes (initial load,
// or a save from this same pane) so the form never shows a stale attempt.
watch(() => store.messageRetentionDays, syncFromStore);

function syncFromStore(): void {
  enabled.value = store.messageRetentionDays != null;
  if (store.messageRetentionDays != null) days.value = store.messageRetentionDays;
}

async function save(): Promise<void> {
  busy.value = true;
  try {
    await store.setMessageRetentionDays(enabled.value ? days.value : null);
  } catch {
    // store.error is already set by the action.
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.add {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-6);
  align-items: start;
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label input {
  color: var(--fg);
}
.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
}
.check input {
  width: auto;
}
.error {
  color: var(--bad);
}
.muted {
  color: var(--fg-muted);
}
</style>
