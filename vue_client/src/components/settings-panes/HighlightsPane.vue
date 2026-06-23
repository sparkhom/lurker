<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <section id="highlights" class="settings-pane">
    <h2>highlights</h2>
    <p class="section-desc">
      Rules whose pattern matches an incoming message mark it as a highlight (line accent + sidebar
      dot). Auto-managed entries track each network's current nick and can only be enabled/disabled.
      For sender masks, per-network or per-channel scope, use the
      <code>/highlight</code> command (e.g. <code>/highlight -mask bob!*@*</code>). Configure
      notification delivery for matched highlights in the Notifications pane.
    </p>
    <p v-if="rulesError" class="error inline">{{ rulesError }}</p>
    <ul class="rule-list">
      <li v-for="rule in rules" :key="rule.id" class="rule" :class="{ auto: rule.auto_managed }">
        <span class="lock" :title="rule.auto_managed ? 'auto-managed (network nick)' : 'user rule'">
          {{ rule.auto_managed ? '🔒' : '' }}
        </span>
        <div class="pat-cell">
          <input
            type="text"
            class="pattern"
            :value="rule.mask ?? rule.pattern ?? ''"
            :disabled="rule.auto_managed || !!rule.mask"
            @change="onRuleField(rule, 'pattern', ($event.target as HTMLInputElement).value)"
            :placeholder="rule.mask ? 'mask' : 'pattern'"
          />
          <span v-if="ruleScopeLabel(rule)" class="scope">{{ ruleScopeLabel(rule) }}</span>
        </div>
        <select
          :value="rule.kind"
          :disabled="rule.auto_managed || !!rule.mask"
          @change="onRuleField(rule, 'kind', ($event.target as HTMLSelectElement).value)"
        >
          <option value="substr">substr</option>
          <option value="full">full</option>
          <option value="glob">glob</option>
          <option value="regex">regex</option>
        </select>
        <label class="ck" title="case sensitive">
          <input
            type="checkbox"
            :checked="rule.case_sensitive"
            :disabled="rule.auto_managed || !!rule.mask"
            @change="
              onRuleField(rule, 'case_sensitive', ($event.target as HTMLInputElement).checked)
            "
          />
          <span>Aa</span>
        </label>
        <label class="ck" title="enabled">
          <input
            type="checkbox"
            :checked="rule.enabled"
            @change="onRuleField(rule, 'enabled', ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ rule.enabled ? 'on' : 'off' }}</span>
        </label>
        <button
          class="link danger"
          :disabled="rule.auto_managed"
          @click="onRuleDelete(rule)"
          title="delete rule"
        >
          delete
        </button>
      </li>
    </ul>
    <div class="rule-add">
      <input
        v-model="newPattern"
        type="text"
        placeholder="add highlight pattern…"
        @keydown.enter="onRuleAdd"
      />
      <select v-model="newKind">
        <option value="substr">substr</option>
        <option value="full">full</option>
        <option value="glob">glob</option>
        <option value="regex">regex</option>
      </select>
      <label class="ck">
        <input type="checkbox" v-model="newCaseSensitive" />
        <span>Aa</span>
      </label>
      <button class="link" :disabled="!newPattern.trim()" @click="onRuleAdd">add</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useHighlightRulesStore } from '../../stores/highlightRules.js';
import type { HighlightRule } from '../../stores/highlightRules.js';
import { useNetworksStore } from '../../stores/networks.js';

type RuleKind = 'substr' | 'full' | 'glob' | 'regex';

const rulesStore = useHighlightRulesStore();
const networks = useNetworksStore();

const rules = computed(() => rulesStore.rules);

const rulesError = ref('');
const newPattern = ref('');
const newKind = ref<RuleKind>('substr');
const newCaseSensitive = ref(false);

// A muted descriptor for a rule's scope: channels and/or the networks it's
// limited to. Empty for a plain global keyword rule (the common case), so the
// row stays uncluttered.
function ruleScopeLabel(rule: HighlightRule): string {
  const parts: string[] = [];
  if (rule.channels?.length) parts.push(rule.channels.join(', '));
  if (rule.networkIds.length) {
    parts.push(
      rule.networkIds.map((id) => networks.networkById(id)?.name || `net:${id}`).join(', '),
    );
  }
  return parts.join(' · ');
}

onMounted(() => {
  if (!rulesStore.loaded) {
    rulesStore.fetchAll().catch((e: any) => {
      rulesError.value = e.message;
    });
  }
});

async function onRuleField(rule: HighlightRule, field: string, value: string | boolean) {
  rulesError.value = '';
  try {
    await rulesStore.update(rule.id, { [field]: value });
  } catch (e: any) {
    rulesError.value = e.message || 'update failed';
    rulesStore.fetchAll().catch(() => {
      /* ignore */
    });
  }
}

async function onRuleDelete(rule: HighlightRule) {
  rulesError.value = '';
  try {
    await rulesStore.remove(rule.id);
  } catch (e: any) {
    rulesError.value = e.message || 'delete failed';
  }
}

async function onRuleAdd() {
  const pattern = newPattern.value.trim();
  if (!pattern) return;
  rulesError.value = '';
  try {
    await rulesStore.create({
      pattern,
      kind: newKind.value,
      case_sensitive: newCaseSensitive.value,
      enabled: true,
    });
    newPattern.value = '';
    newKind.value = 'substr';
    newCaseSensitive.value = false;
  } catch (e: any) {
    rulesError.value = e.message || 'create failed';
  }
}
</script>

<style src="./panes.css"></style>
<style scoped>
.rule-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rule {
  display: grid;
  grid-template-columns: 18px minmax(120px, 1fr) max-content max-content max-content max-content;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.rule:first-child {
  border-top: none;
}
.rule:hover {
  background: var(--bg-soft);
}
.rule.auto .pattern {
  color: var(--fg-muted);
}
.pat-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.pat-cell .pattern {
  width: 100%;
}
/* Muted scope descriptor (channels / networks); color, not size, sets hierarchy. */
.scope {
  color: var(--fg-muted);
}
.lock {
  color: var(--fg-muted);
  text-align: center;
}
.rule .ck {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  cursor: pointer;
}
.rule-add {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-top: var(--space-5);
}
.rule-add input[type='text'] {
  flex: 1;
  min-width: 200px;
}
</style>
