<template>
  <div class="chat" @click="onChatClick">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="logo">lurker</span>
        <span v-if="!connected" class="status off" title="Disconnected">●</span>
      </div>
      <BufferList />
      <div class="sidebar-foot">
        <RouterLink class="link" to="/settings" title="Settings"><i class="fa-solid fa-gear"></i></RouterLink>
        <button class="link" @click="showHighlights = true" title="Highlights"><i class="fa-regular fa-bell"></i></button>
        <button class="link" @click="openAddNetwork" title="Add network"><i class="fa-solid fa-plus"></i></button>
      </div>
    </aside>

    <header v-if="active" class="topic">
      <span class="buffer">{{ bufferLabel }}</span>
      <button
        v-if="isServerBuffer"
        class="link"
        title="Edit network"
        @click="editActiveNetwork"
      ><i class="fa-solid fa-gear"></i></button>
      <template v-if="topic">
        <span class="sep">│</span>
        <span class="topic-text"><LinkedText :text="topic" /></span>
      </template>
    </header>
    <div v-if="active" class="topic-divider"></div>

    <MessageList :pending-scroll-id="pendingScrollId" />
    <MemberList v-if="active" />
    <StatusBar />
    <MessageInput ref="messageInputRef" />

    <NetworkForm
      v-if="showNetworkForm"
      :network="editingNetwork"
      @close="closeNetworkForm"
    />
    <HighlightsModal
      v-if="showHighlights"
      @close="showHighlights = false"
      @jump="onJumpToMessage"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useSocket } from '../composables/useSocket.js';
import { useChatBootstrap } from '../composables/useChatBootstrap.js';
import { useActiveBuffer } from '../composables/useActiveBuffer.js';
import BufferList from '../components/BufferList.vue';
import MessageList from '../components/MessageList.vue';
import MessageInput from '../components/MessageInput.vue';
import MemberList from '../components/MemberList.vue';
import StatusBar from '../components/StatusBar.vue';
import NetworkForm from '../components/NetworkForm.vue';
import HighlightsModal from '../components/HighlightsModal.vue';
import LinkedText from '../components/LinkedText.vue';

const buffers = useBuffersStore();
const { connected } = useSocket();
const { active, topic, isServerBuffer, bufferLabel } = useActiveBuffer();

const showNetworkForm = ref(false);
const editingNetwork = ref(null);
const showHighlights = ref(false);
const pendingScrollId = ref(null);
const messageInputRef = ref(null);

// Forward stray clicks anywhere in the chat frame (topic bar, message list,
// member list, sidebar gutter, etc.) into the message input. The selector
// excludes anything genuinely interactive — buttons, links, form controls,
// and modal contents — and we bail if the user is in the middle of selecting
// text so we don't kill their selection.
function onChatClick(e) {
  if (e.target.closest('button, a, input, textarea, select, label, .modal, [contenteditable=true]')) return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  messageInputRef.value?.focus();
}

function onJumpToMessage({ networkId, target, messageId }) {
  buffers.activate(networkId, target);
  pendingScrollId.value = messageId;
}

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

function editActiveNetwork() {
  const net = active.value?.network;
  if (net) openEditNetwork(net);
}

useChatBootstrap({ onJump: onJumpToMessage });
</script>

<style scoped>
/* WeeChat-style frame: the sidebar runs full height on the left; the topic
   and input bars span the full width to the right of it; and the message
   list + nicklist sit between them. */
.chat {
  display: grid;
  grid-template-columns: 220px 1fr 180px;
  /* The 1px row owns the topic/messages divider as its own grid track,
     outside the scroll container. Putting the line inside .message-list
     (border-top, inset box-shadow) lets row backgrounds and hover states
     paint over it as content scrolls past — the line appears to be eaten
     by the scrolling rows. A dedicated row sits between the two children
     and nothing can paint on top of it. */
  grid-template-rows: auto auto 1fr auto auto;
  grid-template-areas:
    "sidebar topic    topic"
    "sidebar divider  divider"
    "sidebar messages members"
    "sidebar status   status"
    "sidebar input    input";
  height: 100vh;
  overflow: hidden;
}
/* min-height/min-width 0 lets flex/scrolling children stay inside their row. */
.chat > * { min-width: 0; min-height: 0; }

.sidebar {
  grid-area: sidebar;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo { color: var(--accent); font-weight: bold; }
.status.off { color: var(--bad); }
/* Three-column grid pins the cog flush-left, bell perfectly centered, and
   plus flush-right regardless of glyph width. matches the input bar's
   single-line height (8px padding + 1lh content + 1px border) so the
   sidebar-foot's top border lines up with the input bar's top border. */
.sidebar-foot {
  margin-top: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  align-items: center;
}
.sidebar-foot > :nth-child(1) { justify-self: start; }
.sidebar-foot > :nth-child(2) { justify-self: center; }
.sidebar-foot > :nth-child(3) { justify-self: end; }
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0 4px;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}
.link:hover { color: var(--fg); }

.topic {
  grid-area: topic;
  padding: 8px 12px;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  white-space: nowrap;
  overflow: hidden;
}
.topic-divider {
  grid-area: divider;
  background: var(--border);
  height: 1px;
}
.topic .buffer { color: var(--accent); }
.topic .sep    { color: var(--border); }
.topic .topic-text {
  color: var(--fg-muted);
  text-overflow: ellipsis;
  overflow: hidden;
}

/* These selectors target the root elements of the imported components.
   Vue 3 scoped CSS attaches the parent's data-v attribute to a child
   component's root element, so .message-list / .members / .input here
   match the rendered roots of MessageList / MemberList / MessageInput. */
.message-list { grid-area: messages; }
.members      { grid-area: members; border-left: 1px solid var(--border); }
.status-bar   { grid-area: status; }
.input        { grid-area: input; }
</style>
