<template>
  <div class="login">
    <div class="card">
      <h1>Caint</h1>

      <template v-if="loadingStatus">
        <p class="subtitle">Checking setup…</p>
      </template>

      <!-- First-passkey setup: no users, ask for username -->
      <template v-else-if="setup?.needsSetup && setup.mode === 'create-user'">
        <p class="subtitle">First run — pick a username and create a passkey.</p>
        <form @submit.prevent="onCreateUser">
          <label>
            <span>Username</span>
            <input v-model="username" autocomplete="username" autofocus required />
          </label>
          <button type="submit" :disabled="working">
            {{ working ? 'Creating passkey…' : 'Create account' }}
          </button>
        </form>
      </template>

      <!-- First-passkey setup: existing user (post-migration) -->
      <template v-else-if="setup?.needsSetup && setup.mode === 'add-passkey'">
        <p class="subtitle">
          Add a passkey for <strong>{{ setup.username }}</strong> to finish setup.
        </p>
        <button class="primary" :disabled="working" @click="onAddFirstPasskey">
          {{ working ? 'Creating passkey…' : 'Create passkey' }}
        </button>
      </template>

      <!-- Normal login -->
      <template v-else>
        <p class="subtitle">Sign in to your IRC client.</p>
        <button class="primary" :disabled="working" @click="onLogin">
          {{ working ? 'Waiting for passkey…' : 'Sign in with passkey' }}
        </button>
      </template>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const username = ref('');
const working = ref(false);
const loadingStatus = ref(true);
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const setup = ref(null);

onMounted(async () => {
  setup.value = await auth.fetchSetupStatus();
  loadingStatus.value = false;
});

function nextDestination() {
  return route.query.next || '/';
}

async function onLogin() {
  working.value = true;
  try {
    await auth.loginWithPasskey();
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
  } finally {
    working.value = false;
  }
}

async function onCreateUser() {
  if (!username.value.trim()) return;
  working.value = true;
  try {
    await auth.setupFirstPasskey({ username: username.value.trim() });
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
    setup.value = await auth.fetchSetupStatus();
  } finally {
    working.value = false;
  }
}

async function onAddFirstPasskey() {
  working.value = true;
  try {
    await auth.setupFirstPasskey({});
    router.replace(nextDestination());
  } catch (_) {
    setup.value = await auth.fetchSetupStatus();
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.login {
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
form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
label { display: flex; flex-direction: column; gap: 3px; color: var(--fg-muted); }
label span { text-transform: uppercase; letter-spacing: 0.04em; }
button { cursor: pointer; }
button.primary { padding: 8px 12px; }
.error { margin: 0; color: var(--bad); }
</style>
