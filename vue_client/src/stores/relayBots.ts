// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';

// Per-(network, nick) relay-bot marks (#277). A marked nick is a relay / bridge
// bot whose messages wrap another person's speech in an envelope; MessageList
// re-attributes those lines to the embedded speaker at render time. Server is
// the source of truth — marks ship over WS and a `relay-bot-updated` echo fans
// out to every session so the mark stays in sync across devices. Keying is
// network-scoped (same nick on different networks may be unrelated bots),
// mirroring nick notes and ignores.
function key(networkId: number | string, nick: string) {
  return `${networkId}::${(nick || '').toLowerCase()}`;
}

export interface RelayBotEntry {
  /** Custom envelope template; empty string means "use the built-in defaults". */
  pattern: string;
}

export const useRelayBotsStore = defineStore('relayBots', {
  state: () => ({
    // { [networkId::nicklower]: { pattern: string } } — presence of a key IS the mark.
    byKey: {} as Record<string, RelayBotEntry>,
  }),
  getters: {
    isRelay: (state) => (networkId: number | string, nick: string) =>
      !!state.byKey[key(networkId, nick)],
    patternFor: (state) => (networkId: number | string, nick: string) =>
      state.byKey[key(networkId, nick)]?.pattern || '',
    // [{ networkId, nick, pattern }] for a given network — drives `/relay list`.
    listForNetwork: (state) => (networkId: number) => {
      const prefix = `${networkId}::`;
      const out: Array<{ nick: string; pattern: string }> = [];
      for (const [k, entry] of Object.entries(state.byKey)) {
        if (k.startsWith(prefix))
          out.push({ nick: k.slice(prefix.length), pattern: entry.pattern });
      }
      return out;
    },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<string, RelayBotEntry> = {};
      for (const n of networks || []) {
        if (n?.networkId == null) continue;
        for (const entry of n.relayBots || []) {
          if (!entry?.nick) continue;
          next[key(n.networkId, entry.nick)] = { pattern: entry.pattern || '' };
        }
      }
      this.byKey = next;
    },
    applyUpdate(networkId: number | string, nick: string, marked: boolean, pattern: string) {
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      if (marked) {
        this.byKey[k] = { pattern: pattern || '' };
      } else {
        delete this.byKey[k];
      }
    },
    setRelay(networkId: number | string, nick: string, marked: boolean, pattern = '') {
      if (!networkId || !nick) return;
      socketSend({ type: 'set-relay-bot', networkId, nick, marked, pattern });
    },
  },
});
