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
        <p class="subtitle">Welcome — pick a username and create a passkey to join.</p>
        <form @submit.prevent="onAccept">
          <label>
            <span>Username</span>
            <input v-model="username" autocomplete="username" autofocus required />
          </label>
          <button type="submit" :disabled="working || !username.trim()">
            {{ working ? 'Creating passkey…' : 'Create account' }}
          </button>
        </form>
        <p v-if="auth.error" class="error">{{ auth.error }}</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const status = ref(null);
const checking = ref(true);
const username = ref('');
const working = ref(false);

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
  if (!name) return;
  working.value = true;
  try {
    await auth.acceptInvite({ token: route.params.token, username: name });
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
form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
label { display: flex; flex-direction: column; gap: 3px; color: var(--fg-muted); }
label span { text-transform: uppercase; letter-spacing: 0.04em; }
button { cursor: pointer; padding: 8px 12px; }
.error { margin: 0; color: var(--bad); }
.link { color: var(--accent); }
</style>
