import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useAuthStore } from '../stores/auth.js';

let socket = null;
const connected = ref(false);
let reconnectTimer = null;

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

function applyEvent(event) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();

  switch (event.type) {
    case 'state':
      networks.applyState(event);
      break;
    case 'message':
    case 'action':
    case 'notice':
      buffers.pushMessage(event);
      if (!event.self && networks.activeKey !== `${event.networkId}::${event.target}`) {
        buffers.markUnread(event.networkId, event.target);
      }
      break;
    case 'join':
      buffers.addMember(event.networkId, event.target, event.nick);
      buffers.pushMessage(event);
      break;
    case 'part':
    case 'quit':
      buffers.removeMember(event.networkId, event.target, event.nick);
      buffers.pushMessage(event);
      break;
    case 'kick':
      buffers.removeMember(event.networkId, event.target, event.kicked);
      buffers.pushMessage(event);
      break;
    case 'nick':
      buffers.renameMember(event.networkId, event.target, event.nick, event.newNick);
      buffers.pushMessage(event);
      break;
    case 'topic':
      buffers.setTopic(event.networkId, event.target, event.text);
      buffers.pushMessage(event);
      break;
    case 'names':
      buffers.setMembers(event.networkId, event.target, event.members);
      break;
    case 'channel-joined':
      buffers.ensure(event.networkId, event.target);
      break;
    case 'channel-parted':
      buffers.drop(event.networkId, event.target);
      break;
    case 'typing':
      buffers.setTyping(event.networkId, event.target, event.nick, event.state);
      break;
    case 'motd':
    case 'error':
      buffers.pushMessage({ ...event, target: event.target || `:server:${event.networkId}` });
      break;
  }
}

function applySnapshot(snapshot) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.applySnapshot(snapshot);
  for (const net of snapshot) {
    for (const ch of net.channels) {
      buffers.setMembers(net.networkId, ch.name, ch.members.map((nick) => ({ nick, modes: [] })));
      buffers.setTopic(net.networkId, ch.name, ch.topic);
    }
  }
}

function applyBacklog(payload) {
  const buffers = useBuffersStore();
  buffers.replaceBacklog(payload.networkId, payload.target, payload.events);
}

function handleMessage(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }

  if (payload.kind === 'snapshot') {
    applySnapshot(payload.networks);
    return;
  }
  if (payload.kind === 'backlog') {
    applyBacklog(payload);
    return;
  }
  if (payload.kind === 'history') {
    const buffers = useBuffersStore();
    buffers.prependHistory(payload.networkId, payload.target, payload.events, payload.hasMore);
    return;
  }
  if (payload.kind === 'irc') {
    applyEvent(payload);
    return;
  }
}

function open() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    connected.value = true;
  };
  socket.onmessage = (ev) => handleMessage(ev.data);
  socket.onclose = () => {
    connected.value = false;
    socket = null;
    const auth = useAuthStore();
    if (auth.user) {
      reconnectTimer = setTimeout(open, 2000);
    }
  };
  socket.onerror = () => {
    if (socket) socket.close();
  };
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function useSocket() {
  onMounted(() => open());
  onBeforeUnmount(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
  return { connected, send, reconnect: open };
}

export function socketSend(payload) { send(payload); }
