<template>
  <form class="input" @submit.prevent="submit">
    <input
      v-model="text"
      :placeholder="placeholder"
      :disabled="!active"
      autocomplete="off"
    />
    <button type="submit" :disabled="!active || !text.trim() || (isServer && !text.startsWith('/'))">Send</button>
  </form>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { socketSend } from '../composables/useSocket.js';

const networks = useNetworksStore();
const text = ref('');

const active = computed(() => networks.activeBuffer);
const isServer = computed(() => active.value?.target?.startsWith(':server:'));
const sendable = computed(() => !!active.value && !isServer.value);
const placeholder = computed(() => {
  if (!active.value) return 'Select a channel';
  if (isServer.value) return 'Use /raw <line> here to send raw IRC';
  return `Message ${active.value.target} (try /help)`;
});

let typingState = null;
let lastActiveSentAt = 0;
let inactivityTimer = null;
let typingTarget = null;

function sendTyping(networkId, target, state) {
  socketSend({ type: 'typing', networkId, target, state });
}

function clearInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function endTypingTo(target) {
  if (!target) return;
  if (typingState && typingTarget && typingTarget.target === target.target && typingTarget.networkId === target.networkId) {
    sendTyping(target.networkId, target.target, 'done');
  }
  typingState = null;
  typingTarget = null;
  clearInactivityTimer();
}

function onInput() {
  if (!sendable.value) return;
  const { networkId, target } = active.value;
  const trimmed = text.value.trim();

  if (trimmed === '' || text.value.startsWith('/')) {
    if (typingState) {
      sendTyping(networkId, target, 'done');
      typingState = null;
      typingTarget = null;
    }
    clearInactivityTimer();
    return;
  }

  const now = Date.now();
  if (typingState !== 'active' || now - lastActiveSentAt > 3000) {
    sendTyping(networkId, target, 'active');
    typingState = 'active';
    typingTarget = { networkId, target };
    lastActiveSentAt = now;
  }

  clearInactivityTimer();
  const tNet = networkId;
  const tTarget = target;
  inactivityTimer = setTimeout(() => {
    if (typingState === 'active' && text.value.trim() !== '') {
      sendTyping(tNet, tTarget, 'paused');
      typingState = 'paused';
    }
    inactivityTimer = null;
  }, 3000);
}

watch(text, onInput);

watch(active, (newActive, oldActive) => {
  if (oldActive && (!newActive || oldActive.target !== newActive.target || oldActive.networkId !== newActive.networkId)) {
    endTypingTo(oldActive);
  }
});

onBeforeUnmount(() => {
  if (active.value) endTypingTo(active.value);
});

function submit() {
  const raw = text.value;
  if (!raw.trim() || !active.value) return;
  const { networkId, target } = active.value;

  if (raw.startsWith('/')) {
    handleCommand(raw, networkId, target);
  } else if (sendable.value) {
    socketSend({ type: 'send', networkId, target, text: raw });
    typingState = null;
    typingTarget = null;
    clearInactivityTimer();
  } else {
    return;
  }
  text.value = '';
}

function handleCommand(line, networkId, target) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argLine = line.slice(1 + cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case 'me':
      socketSend({ type: 'action', networkId, target, text: argLine });
      break;
    case 'msg':
    case 'query': {
      const [who, ...msgParts] = rest;
      if (!who) return;
      const body = msgParts.join(' ');
      if (body) socketSend({ type: 'send', networkId, target: who, text: body });
      networks.setActive(networkId, who);
      break;
    }
    case 'join':
      if (rest[0]) {
        const ch = rest[0].startsWith('#') ? rest[0] : `#${rest[0]}`;
        socketSend({ type: 'join', networkId, channel: ch });
      }
      break;
    case 'part':
    case 'leave':
      socketSend({ type: 'part', networkId, channel: rest[0] || target, reason: rest.slice(1).join(' ') });
      break;
    case 'raw':
    case 'quote':
      socketSend({ type: 'raw', networkId, line: argLine });
      break;
    case 'help':
      alert('Commands: /me, /msg <nick> <text>, /join #chan, /part [#chan] [reason], /raw <line>');
      break;
    default:
      socketSend({ type: 'raw', networkId, line: line.slice(1) });
  }
}
</script>

<style scoped>
.input {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-alt);
}
input { flex: 1; }
</style>
