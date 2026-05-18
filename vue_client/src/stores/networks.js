// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

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
      // The system-console sentinel is a flat key (no `::`). Treat it as
      // "no IRC buffer active" — the SystemConsole view drives its own
      // header and rendering off the system-log store directly.
      if (!state.activeKey.includes('::')) return null;
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
    // Rewrite sidebar order. Server validates the id set; on 409 it echoes the
    // authoritative list, which we apply so the UI snaps back to truth instead
    // of staying out of sync after a concurrent add/delete from another tab.
    async reorder(ids) {
      try {
        const { networks } = await api('/api/networks/reorder', {
          method: 'POST',
          body: { ids },
        });
        this.networks = networks;
      } catch (err) {
        if (err?.status === 409 && Array.isArray(err.data?.networks)) {
          this.networks = err.data.networks;
        }
        throw err;
      }
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
    async disconnect(id, reason) {
      await api(`/api/networks/${id}/disconnect`, {
        method: 'POST',
        ...(reason ? { body: { reason } } : {}),
      });
    },
    async reconnect(id) {
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    setActive(networkId, target) {
      this.activeKey = `${networkId}::${target}`;
    },
    // System console is the only "buffer" that isn't tied to an IRC network —
    // it's the per-user log of server lifecycle events surfaced via the
    // "lurker" sidebar header. Uses a flat sentinel key (no `::`) so the
    // existing `${networkId}::${target}` parsers ignore it.
    activateSystem() {
      this.activeKey = ':system:';
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
    // Per-(network, nick) peer presence. Single most-recent-event shape:
    // { state, stateAt } where state ∈ {online, offline, away, back}.
    // Stored under the network state bucket so the snapshot apply seeds it
    // instantly; readers (MessageList marker, BufferList decoration,
    // StatusBar segment) look up by lowercase nick.
    applyPeerPresence(networkId, nick, payload) {
      if (!networkId || !nick) return;
      const existing = this.states[networkId] || { networkId, channels: [] };
      const peerPresence = { ...(existing.peerPresence || {}) };
      peerPresence[nick.toLowerCase()] = {
        nick,
        state: payload?.state || null,
        stateAt: payload?.stateAt || null,
        awayMessage: payload?.awayMessage || null,
      };
      this.states[networkId] = { ...existing, peerPresence };
    },
    applyLag(event) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      const v = event.lagMs;
      this.states[event.networkId] = {
        ...existing,
        lagMs: typeof v === 'number' ? v : null,
      };
    },
  },
});
