// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { compileRules, matchEvent, type CompiledRule } from '../utils/highlightMatch.js';

// Highlight rules (issue #349). CRUD goes over REST (the settings pane edits
// fields inline); the server fans a `highlight-rules-changed` event so other
// sessions re-fetch (cross-device sync). The server stamps matched_rule_id at
// insert (drives notifications + the highlights feed + counts, which must work
// with no tab open); the client ALSO evaluates here at render so adding/removing/
// toggling a rule instantly re-colors messages already on screen — mirroring how
// /ignore filters live. Each rule is a full irssi-style rule
// (pattern / mask / channels / kind / case) with optional per-network scope.

export interface HighlightRule {
  id: number;
  pattern: string | null;
  mask: string | null;
  channels: string[] | null;
  kind: string;
  case_sensitive: boolean;
  enabled: boolean;
  auto_managed: boolean;
  // [] = global (every network); otherwise the networks the rule is scoped to
  // (an auto-nick rule spans every network currently using that nick).
  networkIds: number[];
}

// Minimal message shape the render hot path passes to evaluate().
interface HighlightInput {
  nick?: string | null;
  userhost?: string | null;
  target?: string;
  type?: string;
  text?: string | null;
  self?: boolean;
}

// Compile lazily, memoized per network and invalidated whenever the rules array
// identity changes. Every action below assigns a fresh array (never mutates in
// place) so a change reliably busts this cache; steady-state reads are a Map hit.
let cacheRef: HighlightRule[] | null = null;
const perNetwork = new Map<number, CompiledRule[]>();
function compiledFor(rules: HighlightRule[], networkId: number): CompiledRule[] {
  if (cacheRef !== rules) {
    perNetwork.clear();
    cacheRef = rules;
  }
  let c = perNetwork.get(networkId);
  if (!c) {
    // Effective set for this network = global rules plus rules scoped to it.
    const effective = rules.filter(
      (r) => r.networkIds.length === 0 || r.networkIds.includes(networkId),
    );
    c = compileRules(effective);
    perNetwork.set(networkId, c);
  }
  return c;
}

export const useHighlightRulesStore = defineStore('highlightRules', {
  state: () => ({
    rules: [] as HighlightRule[],
    loaded: false,
    loading: false,
    error: '',
  }),
  getters: {
    userRules: (state) => state.rules.filter((r) => !r.auto_managed),
    autoRules: (state) => state.rules.filter((r) => r.auto_managed),

    // The effective rules for a network (global ∪ network-scoped), for the
    // /highlight command listing. networkId null lists only globals.
    rulesFor: (state) => (networkId: number | null) =>
      networkId == null
        ? state.rules.filter((r) => r.networkIds.length === 0)
        : state.rules.filter(
            (r) => r.networkIds.length === 0 || r.networkIds.includes(Number(networkId)),
          ),

    // Render hot path called from MessageList: does any in-scope, enabled rule
    // match this message? Mirrors the server's insert-time matchEvent so a freshly
    // added rule lights up scrollback without a reload.
    evaluate:
      (state) =>
      (networkId: number | string, msg: HighlightInput): boolean => {
        const nid = Number(networkId);
        const compiled = compiledFor(state.rules, nid);
        if (compiled.length === 0) return false;
        return matchEvent(
          {
            type: msg.type ?? 'message',
            self: msg.self,
            text: msg.text ?? null,
            nick: msg.nick ?? null,
            userhost: msg.userhost ?? null,
            target: msg.target ?? '',
          },
          compiled,
        ).matched;
      },
  },
  actions: {
    async fetchAll() {
      if (this.loading) return;
      this.loading = true;
      this.error = '';
      try {
        const { rules } = await api('/api/highlight-rules');
        this.rules = rules || [];
        this.loaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load rules';
        throw e;
      } finally {
        this.loading = false;
      }
    },
    async create(fields: Partial<HighlightRule> & { networkId?: number | null }) {
      const { rule } = await api('/api/highlight-rules', { method: 'POST', body: fields });
      this.rules = [...this.rules, rule];
      return rule as HighlightRule;
    },
    async update(id: number, fields: Partial<HighlightRule> & { networkId?: number | null }) {
      const { rule } = await api(`/api/highlight-rules/${id}`, { method: 'PATCH', body: fields });
      this.rules = this.rules.map((r) => (r.id === id ? rule : r));
      return rule as HighlightRule;
    },
    async remove(id: number) {
      await api(`/api/highlight-rules/${id}`, { method: 'DELETE' });
      this.rules = this.rules.filter((r) => r.id !== id);
    },
    applyServerChanged() {
      // Re-fetch when the server signals rules changed (another tab/device, or
      // an auto-nick rule created on (re)connect / nick change).
      this.fetchAll().catch(() => {
        /* ignore */
      });
    },
  },
});
