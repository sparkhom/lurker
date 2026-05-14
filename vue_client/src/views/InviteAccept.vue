<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: Elastic-2.0
-->

<template>
  <div class="invite">
    <div class="card">
      <h1>Lurker</h1>

      <template v-if="checking">
        <p class="subtitle">Checking invite…</p>
      </template>

      <template v-else-if="!status?.valid">
        <p class="subtitle">
          {{ status?.expired ? 'This invite has expired.' : 'This invite is not valid.' }}
        </p>
        <p class="muted">Ask the operator for a fresh link.</p>
        <RouterLink to="/login" class="link">go to sign-in</RouterLink>
      </template>

      <template v-else>
        <p class="subtitle">Welcome — pick a username and password.</p>
        <p class="warning">
          Only use a Lurker instance belonging to yourself or a close friend!
        </p>
        <form @submit.prevent="onAccept">
          <label>
            <span>Username</span>
            <input
              v-model="username"
              autocomplete="username"
              autofocus
              required
              placeholder="lurker username"
            />
          </label>
          <p class="hint">Your Lurker account login — not the nick you'll use on IRC networks.</p>
          <label>
            <span>Password</span>
            <input
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              minlength="8"
            />
          </label>
          <p class="hint">8+ characters. You can add a passkey later in settings.</p>
          <button type="submit" :disabled="working || !canSubmit">
            {{ submitLabel }}
          </button>
        </form>
        <p v-if="auth.error" class="error">{{ auth.error }}</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const status = ref(null);
const checking = ref(true);
const username = ref('');
const password = ref('');
const working = ref(false);

const canSubmit = computed(() => {
  if (!username.value.trim()) return false;
  if (!password.value) return false;
  return true;
});

const submitLabel = computed(() => (working.value ? 'Creating account…' : 'Create account'));

onMounted(async () => {
  try {
    status.value = await auth.fetchInviteStatus(route.params.token);
  } catch (_) {
    status.value = { valid: false };
  } finally {
    checking.value = false;
  }
});

async function onAccept() {
  const name = username.value.trim();
  if (!canSubmit.value) return;
  working.value = true;
  try {
    await auth.acceptInviteWithPassword({
      token: route.params.token,
      username: name,
      password: password.value,
    });
    router.replace('/');
  } catch (_) {
    // surfaced via auth.error
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.invite {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  border: 1px solid var(--accent);
  padding: 20px 24px;
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h1 { margin: 0; color: var(--accent); font-weight: 600; }
.subtitle { margin: 0; color: var(--fg-muted); }
.muted { margin: 0; color: var(--fg-muted); font-style: italic; }
.warning {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--warn, var(--accent));
  color: var(--warn, var(--accent));
  background: transparent;
}
form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
label { display: flex; flex-direction: column; gap: 3px; color: var(--fg-muted); }
label span { text-transform: uppercase; letter-spacing: 0.04em; }
button { cursor: pointer; padding: 8px 12px; }
.error { margin: 0; color: var(--bad); }
.link { color: var(--accent); }
.hint { margin: 0; color: var(--fg-muted); font-size: 0.9em; }
</style>
