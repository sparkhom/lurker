<template>
  <div class="chat">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="logo">caint</span>
        <span class="status" :class="{ on: connected, off: !connected }">{{ connected ? '●' : '○' }}</span>
        <button class="link" @click="openAddNetwork" title="Add network">+</button>
      </div>
      <BufferList @edit-network="openEditNetwork" />
      <div class="sidebar-foot">
        <span class="user">{{ auth.user?.username }}</span>
        <RouterLink class="link" to="/settings">settings</RouterLink>
        <button class="link" @click="signOut">sign out</button>
      </div>
    </aside>

    <main class="main">
      <header v-if="active" class="topic">
        <div>
          <strong>{{ activeLabel }}</strong>
          <span v-if="topic" class="topic-text">— {{ topic }}</span>
        </div>
        <div class="meta">{{ active.network?.name }} · {{ networkState }}</div>
      </header>
      <header v-else class="topic">
        <div><em>No buffer selected</em></div>
      </header>

      <MessageList />
      <TypingIndicator />
      <MessageInput />
    </main>

    <aside v-if="active" class="members">
      <MemberList />
    </aside>

    <NetworkForm
      v-if="showNetworkForm"
      :network="editingNetwork"
      @close="closeNetworkForm"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../stores/auth.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSocket } from '../composables/useSocket.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import NetworkForm from '../components/NetworkForm.vue';
import TypingIndicator from '../components/TypingIndicator.vue';

const auth = useAuthStore();
const networks = useNetworksStore();
const buffers = useBuffersStore();
const settings = useSettingsStore();
const router = useRouter();
const { connected } = useSocket();

const showNetworkForm = ref(false);
const editingNetwork = ref(null);
const { activeKey } = storeToRefs(networks);

function openAddNetwork() {
  editingNetwork.value = null;
  showNetworkForm.value = true;
}
function openEditNetwork(net) {
  editingNetwork.value = net;
  showNetworkForm.value = true;
}
function closeNetworkForm() {
  showNetworkForm.value = false;
  editingNetwork.value = null;
}

const active = computed(() => networks.activeBuffer);
const activeBuf = computed(() => (activeKey.value ? buffers.byKey(activeKey.value) : null));
const topic = computed(() => activeBuf.value?.topic);
const activeLabel = computed(() => {
  const t = active.value?.target;
  if (!t) return '';
  if (t.startsWith(':server:')) return '(server console)';
  return t;
});
const networkState = computed(() => {
  const id = active.value?.networkId;
  if (id == null) return '';
  return networks.states[id]?.state || 'unknown';
});

onMounted(async () => {
  if (!settings.loaded) settings.fetchAll().catch(() => {});
  await networks.fetchAll();
});

async function signOut() {
  await auth.logout();
  router.replace('/login');
}
</script>

<style scoped>
.chat {
  display: grid;
  grid-template-columns: 240px 1fr 200px;
  height: 100vh;
}
.sidebar {
  background: var(--bg-alt);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo { color: var(--accent); font-weight: bold; flex: 1; }
.status.on { color: var(--good); }
.status.off { color: var(--bad); }
.sidebar-foot {
  margin-top: auto;
  padding: 12px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.user { flex: 1; color: var(--fg-muted); }
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 4px;
  cursor: pointer;
  font: inherit;
}
.link:hover { color: var(--fg); }

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.topic {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-alt);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.topic-text { color: var(--fg-muted); margin-left: 8px; }
.meta { font-size: 12px; color: var(--fg-muted); }

.members {
  background: var(--bg-alt);
  border-left: 1px solid var(--border);
  overflow: auto;
}
</style>
