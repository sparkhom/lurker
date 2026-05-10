import { defineStore } from 'pinia';
import { api } from '../api.js';

export const useNetworksStore = defineStore('networks', {
  state: () => ({
    networks: [],
    states: {},
    activeKey: null,
  }),
  getters: {
    networkById: (state) => (id) => state.networks.find((n) => n.id === id) || null,
    activeBuffer(state) {
      if (!state.activeKey) return null;
      const [networkId, name] = state.activeKey.split('::');
      const id = Number(networkId);
      return { networkId: id, target: name, network: state.networks.find((n) => n.id === id) };
    },
  },
  actions: {
    async fetchAll() {
      const { networks } = await api('/api/networks');
      this.networks = networks;
    },
    async create(payload) {
      const { network } = await api('/api/networks', { method: 'POST', body: payload });
      this.networks.push(network);
      return network;
    },
    async update(id, patch) {
      const { network } = await api(`/api/networks/${id}`, { method: 'PATCH', body: patch });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
      return network;
    },
    async remove(id) {
      await api(`/api/networks/${id}`, { method: 'DELETE' });
      this.networks = this.networks.filter((n) => n.id !== id);
      delete this.states[id];
      if (this.activeKey?.startsWith(`${id}::`)) this.activeKey = null;
    },
    async connect(id) {
      await api(`/api/networks/${id}/connect`, { method: 'POST' });
    },
    async disconnect(id) {
      await api(`/api/networks/${id}/disconnect`, { method: 'POST' });
    },
    async reconnect(id) {
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    setActive(networkId, target) {
      this.activeKey = `${networkId}::${target}`;
    },
    applySnapshot(networks) {
      const map = {};
      for (const snap of networks) map[snap.networkId] = snap;
      this.states = map;
    },
    applyState(event) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        state: event.state,
        nick: event.nick || existing.nick,
      };
    },
    applyUserMode(event) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        userModes: typeof event.modes === 'string' ? event.modes : '',
      };
    },
    applyAwayState(event) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        away: event.away || null,
      };
    },
  },
});
