import { defineStore } from 'pinia';

const MAX_PER_BUFFER = 500;
const TYPING_DURATIONS = { active: 6000, paused: 30000 };

const typingTimers = new Map();

function key(networkId, target) {
  return `${networkId}::${target}`;
}

function typingKey(networkId, target, nick) {
  return `${networkId}::${target}::${nick.toLowerCase()}`;
}

function clearTypingTimer(networkId, target, nick) {
  const k = typingKey(networkId, target, nick);
  const id = typingTimers.get(k);
  if (id) {
    clearTimeout(id);
    typingTimers.delete(k);
  }
}

function ensureBuffer(state, networkId, target) {
  const k = key(networkId, target);
  if (!state.buffers[k]) {
    state.buffers[k] = {
      networkId,
      target,
      messages: [],
      members: [],
      topic: null,
      unread: 0,
      typing: {},
      oldestId: null,
      hasMore: true,
      loadingHistory: false,
    };
  }
  if (!state.buffers[k].typing) state.buffers[k].typing = {};
  return state.buffers[k];
}

export const useBuffersStore = defineStore('buffers', {
  state: () => ({
    buffers: {},
  }),
  getters: {
    list: (state) => Object.values(state.buffers),
    byKey: (state) => (k) => state.buffers[k] || null,
    forNetwork: (state) => (networkId) => Object.values(state.buffers).filter((b) => b.networkId === networkId),
  },
  actions: {
    ensure(networkId, target) {
      return ensureBuffer(this, networkId, target);
    },
    pushMessage(event) {
      if (!event.target) return;
      const buf = ensureBuffer(this, event.networkId, event.target);
      buf.messages.push(event);
      if (buf.messages.length > MAX_PER_BUFFER) buf.messages.splice(0, buf.messages.length - MAX_PER_BUFFER);
      if (buf.oldestId == null && event.id != null) buf.oldestId = event.id;
      if (event.nick && buf.typing[event.nick]) {
        clearTypingTimer(event.networkId, event.target, event.nick);
        delete buf.typing[event.nick];
      }
    },
    replaceBacklog(networkId, target, events) {
      const buf = ensureBuffer(this, networkId, target);
      buf.messages = events.slice(-MAX_PER_BUFFER);
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? null;
      buf.hasMore = events.length >= 50;
    },
    prependHistory(networkId, target, events, hasMore) {
      const buf = ensureBuffer(this, networkId, target);
      buf.messages = [...events, ...buf.messages];
      const first = buf.messages[0];
      buf.oldestId = first?.id ?? buf.oldestId;
      buf.hasMore = !!hasMore;
      buf.loadingHistory = false;
    },
    setLoadingHistory(networkId, target, loading) {
      const buf = ensureBuffer(this, networkId, target);
      buf.loadingHistory = loading;
    },
    setMembers(networkId, target, members) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = members;
    },
    setTopic(networkId, target, topic) {
      const buf = ensureBuffer(this, networkId, target);
      buf.topic = topic;
    },
    removeMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      buf.members = buf.members.filter((m) => (m.nick || m) !== nick);
    },
    addMember(networkId, target, nick) {
      const buf = ensureBuffer(this, networkId, target);
      const existing = buf.members.find((m) => (m.nick || m) === nick);
      if (!existing) buf.members.push({ nick, modes: [] });
    },
    renameMember(networkId, target, oldNick, newNick) {
      const buf = ensureBuffer(this, networkId, target);
      for (const m of buf.members) {
        if ((m.nick || m) === oldNick) {
          if (typeof m === 'object') m.nick = newNick;
        }
      }
    },
    drop(networkId, target) {
      delete this.buffers[key(networkId, target)];
    },
    markRead(networkId, target) {
      const buf = this.buffers[key(networkId, target)];
      if (buf) buf.unread = 0;
    },
    markUnread(networkId, target) {
      const buf = this.buffers[key(networkId, target)];
      if (!buf) return;
      buf.unread += 1;
    },
    setTyping(networkId, target, nick, state) {
      if (!nick) return;
      const buf = ensureBuffer(this, networkId, target);
      clearTypingTimer(networkId, target, nick);

      if (state === 'done') {
        delete buf.typing[nick];
        return;
      }

      const duration = TYPING_DURATIONS[state];
      if (!duration) return;
      buf.typing[nick] = { state, expiresAt: Date.now() + duration };

      const timer = setTimeout(() => {
        const b = this.buffers[key(networkId, target)];
        if (b && b.typing[nick]) {
          delete b.typing[nick];
        }
        typingTimers.delete(typingKey(networkId, target, nick));
      }, duration);
      typingTimers.set(typingKey(networkId, target, nick), timer);
    },
  },
});
