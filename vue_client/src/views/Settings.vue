<template>
  <div class="settings-page">
    <header class="bar">
      <RouterLink to="/" class="back">← back</RouterLink>
      <h1>settings</h1>
      <input v-model="search" placeholder="Search keys or descriptions…" class="search" />
      <label class="toggle">
        <input type="checkbox" v-model="modifiedOnly" />
        <span>modified only</span>
      </label>
      <button class="link danger" :disabled="!anyModified || working" @click="onResetAll">reset all</button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-if="!settings.loaded && !filtered.length" class="muted">Loading settings…</p>
    <p v-else-if="!filtered.length" class="muted">No settings match.</p>

    <ul class="rows">
      <li v-for="opt in filtered" :key="opt.key" class="row" :class="{ modified: settings.isModified(opt.key) }">
        <span class="marker" :title="settings.isModified(opt.key) ? 'modified from default' : ''">{{ settings.isModified(opt.key) ? '*' : '' }}</span>
        <div class="head">
          <span class="key">{{ opt.key }}</span>
          <span class="type">{{ opt.type }}</span>
          <button v-if="settings.isModified(opt.key)" class="link reset" @click="onReset(opt.key)" title="reset to default">reset</button>
        </div>
        <div class="desc">{{ opt.description }}</div>
        <div class="editor">
          <!-- bool -->
          <label v-if="opt.type === 'bool'" class="bool">
            <input type="checkbox" :checked="settings.effective(opt.key)" @change="onCommit(opt.key, $event.target.checked)" />
            <span>{{ settings.effective(opt.key) ? 'on' : 'off' }}</span>
          </label>
          <!-- int -->
          <input
            v-else-if="opt.type === 'int'"
            type="number"
            :min="opt.min"
            :max="opt.max"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, Number($event.target.value))"
          />
          <!-- enum -->
          <select
            v-else-if="opt.type === 'enum'"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, $event.target.value)"
          >
            <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
          </select>
          <!-- color -->
          <span v-else-if="opt.type === 'color'" class="color-edit">
            <span class="swatch" :style="{ background: settings.effective(opt.key) }"></span>
            <input
              type="text"
              :value="settings.effective(opt.key)"
              @change="onCommit(opt.key, $event.target.value)"
            />
          </span>
          <!-- string-list -->
          <textarea
            v-else-if="opt.type === 'string-list'"
            :value="(settings.effective(opt.key) || []).join('\n')"
            @change="onCommit(opt.key, $event.target.value.split('\n').map(s => s.trim()).filter(Boolean))"
            rows="6"
          ></textarea>
          <!-- string (default) -->
          <input
            v-else
            type="text"
            :value="settings.effective(opt.key)"
            @change="onCommit(opt.key, $event.target.value)"
          />
        </div>
        <div v-if="settings.isModified(opt.key)" class="default-line">
          default: <code>{{ formatDefault(opt) }}</code>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useSocket } from '../composables/useSocket.js';

useSocket();

const settings = useSettingsStore();
const search = ref('');
const modifiedOnly = ref(false);
const error = ref('');
const working = ref(false);

onMounted(() => {
  if (!settings.loaded) settings.fetchAll().catch((e) => { error.value = e.message; });
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return settings.registry.filter((opt) => {
    if (modifiedOnly.value && !settings.isModified(opt.key)) return false;
    if (!q) return true;
    return opt.key.toLowerCase().includes(q) || (opt.description || '').toLowerCase().includes(q);
  });
});

const anyModified = computed(() => settings.registry.some((o) => settings.isModified(o.key)));

function formatDefault(opt) {
  const v = opt.default;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

async function onCommit(key, value) {
  error.value = '';
  working.value = true;
  try {
    await settings.setValue(key, value);
  } catch (e) {
    error.value = e.message || 'failed to save';
  } finally {
    working.value = false;
  }
}

async function onReset(key) {
  error.value = '';
  working.value = true;
  try {
    await settings.reset(key);
  } catch (e) {
    error.value = e.message || 'failed to reset';
  } finally {
    working.value = false;
  }
}

async function onResetAll() {
  if (!confirm('Reset every setting to its default?')) return;
  error.value = '';
  working.value = true;
  try {
    await settings.resetAll();
  } catch (e) {
    error.value = e.message || 'failed to reset';
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.settings-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-alt);
}
.bar h1 { margin: 0; font-size: 14px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; flex: 0 0 auto; }
.bar .back { color: var(--accent); text-decoration: none; font-size: 13px; }
.bar .back:hover { color: var(--fg); }
.bar .search {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 6px 10px;
  border-radius: 4px;
  font: inherit;
}
.bar .search:focus { outline: 1px solid var(--accent); }
.bar .toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 2px 6px;
  cursor: pointer;
  font: inherit;
}
.link:hover:not(:disabled) { color: var(--fg); }
.link:disabled { opacity: 0.4; cursor: not-allowed; }
.link.danger { color: var(--bad); }
.link.reset { font-size: 11px; }

.error {
  background: rgba(255, 85, 85, 0.1);
  color: var(--bad);
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  margin: 0;
  font-size: 13px;
}
.muted {
  text-align: center;
  color: var(--fg-muted);
  padding: 32px;
  font-style: italic;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.row {
  display: grid;
  grid-template-columns: 16px 1fr;
  grid-template-areas:
    "marker head"
    ".      desc"
    ".      editor"
    ".      default";
  gap: 4px 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.row:hover { background: var(--bg-alt); }
.row.modified .key { color: var(--warn); }

.marker { grid-area: marker; color: var(--warn); font-family: var(--mono); }
.head { grid-area: head; display: flex; align-items: center; gap: 10px; }
.key { font-family: var(--mono); font-weight: 600; color: var(--accent); }
.type {
  font-size: 11px;
  color: var(--fg-muted);
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: lowercase;
}
.desc { grid-area: desc; color: var(--fg-muted); font-size: 12px; }

.editor { grid-area: editor; margin-top: 4px; }
.editor input[type="text"],
.editor input[type="number"],
.editor select,
.editor textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 4px 8px;
  border-radius: 4px;
  font: inherit;
  font-family: var(--mono);
  font-size: 12px;
}
.editor input[type="text"],
.editor select { min-width: 280px; }
.editor input[type="number"] { width: 120px; }
.editor textarea {
  width: 100%;
  max-width: 480px;
  resize: vertical;
}
.editor .bool { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.editor .color-edit { display: flex; align-items: center; gap: 8px; }
.editor .swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid var(--border);
  display: inline-block;
}
.default-line { grid-area: default; font-size: 11px; color: var(--fg-muted); }
.default-line code {
  font-family: var(--mono);
  background: var(--bg-soft);
  padding: 1px 4px;
  border-radius: 2px;
}
</style>
