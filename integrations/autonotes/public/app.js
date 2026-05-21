// Single-page UI for the autonotes integration. Three views, hash router,
// no framework. Talks to the Express server in ../server.js, which proxies
// the operator's commands to Lurker's MCP endpoint.

const $ = (id) => document.getElementById(id);
const els = {
  config: $('view-config'),
  scan: $('view-scan'),
  review: $('view-review'),
  configForm: $('config-form'),
  configStatus: $('config-status'),
  envWarning: $('env-warning'),
  scanForm: $('scan-form'),
  scanStatus: $('scan-status'),
  scanSubmit: $('scan-submit'),
  reviewSummary: $('review-summary'),
  reviewList: $('review-list'),
  reviewActions: $('review-actions'),
  applyAll: $('apply-all'),
  tracePanel: $('trace-panel'),
  traceList: $('trace-list'),
  traceTotals: $('trace-totals'),
};

// Sonnet 4.6 pricing per million tokens. Used purely for the audit-view cost
// readout — actual billing comes from Anthropic, this is informational. If
// you change MODEL in lib/agent.js, update these to match (e.g. Opus 4.7 is
// 5 / 25 / 0.5 / 6.25).
const PRICING = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
};

const state = {
  scope: null,
  networks: [],
  buffersByNetwork: new Map(),
  scan: null,
  cards: new Map(), // nick -> { proposal, status, note }
  pollHandle: null,
  activeScanId: null, // scan whose review route is currently active
  renderedEventCount: 0, // index up to which the trace has been rendered
  turnEls: new Map(), // turn number -> { container, body }
  isApplyingAll: false, // true while the apply-all loop is in flight
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = 'status' + (kind ? ` ${kind}` : '');
}

function showView(name) {
  for (const v of ['config', 'scan', 'review']) {
    els[v].hidden = v !== name;
  }
}

// ---------------- Router ----------------

function route() {
  const hash = location.hash || '';
  if (hash.startsWith('#review/')) {
    const id = hash.slice('#review/'.length);
    enterReview(id);
  } else if (hash === '#scan') {
    enterScan();
  } else {
    enterConfig();
  }
}

window.addEventListener('hashchange', route);

// ---------------- Config view ----------------

async function enterConfig() {
  showView('config');
  stopPolling();
  try {
    const cfg = await api('/api/config');
    if (cfg.lurkerUrl) els.configForm.lurkerUrl.value = cfg.lurkerUrl;
    if (cfg.hasToken) {
      els.configForm.lurkerToken.placeholder = `current: ${cfg.lurkerToken}`;
    }
    els.envWarning.hidden = Boolean(cfg.anthropicKeyPresent);
    if (cfg.hasToken && state.scope === null) {
      setStatus(els.configStatus, 'Token saved. Re-test to confirm scope.');
    }
  } catch (err) {
    setStatus(els.configStatus, err.message, 'err');
  }
}

els.configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus(els.configStatus, 'Testing connection…');
  const fd = new FormData(els.configForm);
  try {
    const result = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        lurkerUrl: fd.get('lurkerUrl'),
        lurkerToken: fd.get('lurkerToken'),
      }),
    });
    state.scope = result.scope;
    setStatus(
      els.configStatus,
      `Connected. Token scope: ${result.scope}. ${result.toolNames.length} tools visible.`,
      'ok',
    );
    setTimeout(() => (location.hash = '#scan'), 400);
  } catch (err) {
    setStatus(els.configStatus, err.message, 'err');
  }
});

// ---------------- Scan view ----------------

async function enterScan() {
  showView('scan');
  stopPolling();
  setStatus(els.scanStatus, '');
  try {
    const cfg = await api('/api/config');
    if (!cfg.hasToken) {
      location.hash = '#config';
      return;
    }
    state.networks = await api('/api/networks');
    populateNetworks(cfg.lastNetworkId, cfg.lastTarget, cfg.lastDepth);
  } catch (err) {
    setStatus(els.scanStatus, err.message, 'err');
  }
}

// Stable handler ref so populateNetworks can remove-then-add it idempotently
// — the function runs on every visit to the Scan view.
function onNetworkChange() {
  loadBuffers(null);
}

function populateNetworks(lastNetworkId, lastTarget, lastDepth) {
  const netSel = els.scanForm.networkId;
  netSel.innerHTML = '';
  for (const n of state.networks) {
    const opt = document.createElement('option');
    opt.value = String(n.id);
    opt.textContent = `${n.name} (${n.connected ? 'connected' : 'offline'} as ${n.nick})`;
    netSel.appendChild(opt);
  }
  if (lastNetworkId != null && state.networks.some((n) => n.id === lastNetworkId)) {
    netSel.value = String(lastNetworkId);
  }
  els.scanForm.depth.value = lastDepth || 200;
  // remove-then-add so repeated visits to the Scan view don't stack handlers.
  netSel.removeEventListener('change', onNetworkChange);
  netSel.addEventListener('change', onNetworkChange);
  loadBuffers(lastTarget || null);
}

async function loadBuffers(preferredTarget) {
  const networkId = Number(els.scanForm.networkId.value);
  if (!networkId) return;
  const bufSel = els.scanForm.target;
  bufSel.innerHTML = '<option>loading…</option>';
  try {
    let buffers = state.buffersByNetwork.get(networkId);
    if (!buffers) {
      buffers = await api(`/api/buffers?networkId=${networkId}`);
      state.buffersByNetwork.set(networkId, buffers);
    }
    bufSel.innerHTML = '';
    for (const b of buffers) {
      const opt = document.createElement('option');
      opt.value = b.target;
      opt.textContent = `${b.target} (${b.kind})`;
      bufSel.appendChild(opt);
    }
    if (preferredTarget && buffers.some((b) => b.target === preferredTarget)) {
      bufSel.value = preferredTarget;
    }
  } catch (err) {
    bufSel.innerHTML = '';
    setStatus(els.scanStatus, err.message, 'err');
  }
}

els.scanForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.scanSubmit.disabled = true;
  setStatus(els.scanStatus, 'Starting scan…');
  try {
    const body = {
      networkId: Number(els.scanForm.networkId.value),
      target: els.scanForm.target.value,
      depth: Number(els.scanForm.depth.value),
    };
    const { scanId } = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    location.hash = `#review/${scanId}`;
  } catch (err) {
    setStatus(els.scanStatus, err.message, 'err');
  } finally {
    els.scanSubmit.disabled = false;
  }
});

// ---------------- Review view ----------------

function enterReview(scanId) {
  showView('review');
  stopPolling();
  state.activeScanId = scanId;
  state.cards.clear();
  state.renderedEventCount = 0;
  state.turnEls.clear();
  els.reviewList.innerHTML = '';
  els.traceList.innerHTML = '';
  els.traceTotals.textContent = '';
  els.tracePanel.hidden = true;
  els.reviewActions.hidden = true;
  setStatus(els.reviewSummary, 'Running scan…');
  pollScan(scanId);
}

function stopPolling() {
  // Clear activeScanId too — an in-flight pollScan() fetch will resolve after
  // this runs and would otherwise schedule a fresh timeout that outlives the
  // navigation. pollScan() checks this id before scheduling the next tick.
  state.activeScanId = null;
  if (state.pollHandle) {
    clearTimeout(state.pollHandle);
    state.pollHandle = null;
  }
}

async function pollScan(scanId) {
  if (scanId !== state.activeScanId) return;
  try {
    const scan = await api(`/api/scan/${scanId}`);
    // The user may have navigated away while the fetch was in flight.
    if (scanId !== state.activeScanId) return;
    state.scan = scan;
    renderTrace(scan);

    if (scan.status === 'running') {
      setStatus(els.reviewSummary, `Running… ${scan.toolCallCount} tool calls so far`);
      state.pollHandle = setTimeout(() => pollScan(scanId), 2000);
      return;
    }
    if (scan.status === 'error') {
      setStatus(els.reviewSummary, `Scan failed: ${scan.error}`, 'err');
      return;
    }
    renderReview(scan);
  } catch (err) {
    if (scanId !== state.activeScanId) return;
    setStatus(els.reviewSummary, err.message, 'err');
  }
}

function renderTrace(scan) {
  const events = scan.events || [];
  if (events.length === 0) return;
  els.tracePanel.hidden = false;

  // Append only events we haven't drawn yet — keeps the polling cheap and
  // avoids the DOM flicker of re-rendering the whole trace on every tick.
  for (let i = state.renderedEventCount; i < events.length; i++) {
    appendTraceEvent(events[i]);
  }
  state.renderedEventCount = events.length;

  // The last `turn` event carries the running totals; surface them in the summary.
  let lastTurn = null;
  for (const ev of events) if (ev.type === 'turn') lastTurn = ev;
  if (lastTurn?.totals) {
    els.traceTotals.textContent = formatTotalsLine(lastTurn.totals);
  }
}

function appendTraceEvent(ev) {
  if (ev.type === 'turn') {
    const wrap = document.createElement('div');
    wrap.className = 'turn';
    const head = document.createElement('div');
    head.className = 'turn-head';
    head.textContent = `Turn ${ev.turn + 1} · ${formatUsageLine(ev.usage)} · ${ev.durationMs}ms · stop=${ev.stopReason}`;
    const body = document.createElement('div');
    body.className = 'turn-body';
    wrap.appendChild(head);
    wrap.appendChild(body);
    els.traceList.appendChild(wrap);
    state.turnEls.set(ev.turn, { container: wrap, body });
    return;
  }

  const turnEl = state.turnEls.get(ev.turn);
  if (!turnEl) return;
  const body = turnEl.body;

  if (ev.type === 'thinking') {
    const div = document.createElement('div');
    div.className = 'trace-thinking';
    div.innerHTML = `<span class="trace-tag">thinking</span> <span class="trace-text"></span>`;
    div.querySelector('.trace-text').textContent = ev.text;
    body.appendChild(div);
  } else if (ev.type === 'text') {
    const div = document.createElement('div');
    div.className = 'trace-text-block';
    div.innerHTML = `<span class="trace-tag">say</span> <span class="trace-text"></span>`;
    div.querySelector('.trace-text').textContent = ev.text;
    body.appendChild(div);
  } else if (ev.type === 'tool_use') {
    const div = document.createElement('div');
    div.className = 'trace-tool';
    div.dataset.toolUseId = ev.id;
    const args = formatToolArgs(ev.input);
    div.innerHTML = `<div class="trace-tool-call"><span class="trace-tag">tool</span> <code class="tool-name"></code><code class="tool-args"></code></div><div class="trace-tool-result trace-pending">running…</div>`;
    div.querySelector('.tool-name').textContent = ev.name;
    div.querySelector('.tool-args').textContent = args;
    body.appendChild(div);
  } else if (ev.type === 'tool_result') {
    const target = body.querySelector(
      `.trace-tool[data-tool-use-id="${ev.toolUseId}"] .trace-tool-result`,
    );
    if (target) {
      target.classList.remove('trace-pending');
      target.classList.toggle('trace-error', Boolean(ev.isError));
      target.textContent = `→ ${ev.summary}`;
    }
  }
}

function formatUsageLine(u) {
  if (!u) return '';
  const parts = [`${formatNumber(u.input_tokens)} in`, `${formatNumber(u.output_tokens)} out`];
  if (u.cache_creation_input_tokens)
    parts.push(`${formatNumber(u.cache_creation_input_tokens)} cache-w`);
  if (u.cache_read_input_tokens) parts.push(`${formatNumber(u.cache_read_input_tokens)} cache-r`);
  return parts.join(' · ');
}

function formatTotalsLine(t) {
  const cost =
    (t.input_tokens * PRICING.input +
      t.output_tokens * PRICING.output +
      t.cache_read_input_tokens * PRICING.cacheRead +
      t.cache_creation_input_tokens * PRICING.cacheWrite5m) /
    1e6;
  return `${formatNumber(t.input_tokens)} in · ${formatNumber(t.output_tokens)} out · ${formatNumber(t.cache_creation_input_tokens)} cache-w · ${formatNumber(t.cache_read_input_tokens)} cache-r · ~$${cost.toFixed(4)}`;
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatToolArgs(input) {
  try {
    const compact = JSON.stringify(input);
    return compact.length > 140 ? compact.slice(0, 139) + '…' : compact;
  } catch {
    return '{}';
  }
}

function renderReview(scan) {
  const proposals = scan.proposals || [];
  if (proposals.length === 0) {
    setStatus(els.reviewSummary, 'Scan complete. No proposed changes.', 'ok');
    return;
  }
  setStatus(
    els.reviewSummary,
    `Scan complete. ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}. Review and apply.`,
    'ok',
  );
  els.reviewList.innerHTML = '';
  for (const p of proposals) {
    const card = buildCard(p, scan.messages || {});
    state.cards.set(p.nick, { proposal: p, status: 'pending', card });
    els.reviewList.appendChild(card.root);
  }
  els.reviewActions.hidden = false;
  updateApplyAll();
}

function buildCard(p, messages) {
  const root = document.createElement('div');
  root.className = 'card';

  root.appendChild(
    h(`<div class="card-head"><span class="nick">${escapeHtml(p.nick)}</span></div>`),
  );

  const currentField = document.createElement('div');
  currentField.className = 'field';
  currentField.innerHTML = `<div class="field-label">Current note</div>`;
  const currentNote = document.createElement('div');
  currentNote.className = 'current-note' + (p.currentNote ? '' : ' empty');
  currentNote.textContent = p.currentNote || '(none)';
  currentField.appendChild(currentNote);
  root.appendChild(currentField);

  const proposedField = document.createElement('div');
  proposedField.className = 'field';
  proposedField.innerHTML = `<div class="field-label">Proposed note (editable)</div>`;
  const textarea = document.createElement('textarea');
  textarea.className = 'proposed-textarea';
  textarea.rows = 2;
  textarea.value = p.proposedNote;
  proposedField.appendChild(textarea);
  root.appendChild(proposedField);

  if (p.rationale) {
    const r = document.createElement('div');
    r.className = 'field rationale';
    r.textContent = p.rationale;
    root.appendChild(r);
  }

  if (p.evidence && p.evidence.length > 0) {
    const toggle = document.createElement('button');
    toggle.className = 'evidence-toggle';
    toggle.type = 'button';
    toggle.textContent = `Show ${p.evidence.length} evidence message${p.evidence.length === 1 ? '' : 's'}`;
    root.appendChild(toggle);

    const evidence = document.createElement('div');
    evidence.className = 'evidence';
    evidence.hidden = true;
    for (const id of p.evidence) {
      const msg = messages[id];
      const line = document.createElement('div');
      line.className = 'evidence-line';
      if (msg) {
        const ts = new Date(msg.time).toISOString().replace('T', ' ').slice(0, 16);
        line.innerHTML = `<span class="ts">${ts}</span><strong>${escapeHtml(msg.nick)}:</strong> ${escapeHtml(msg.text)}`;
      } else {
        line.textContent = `[message ${id} not in cache]`;
      }
      evidence.appendChild(line);
    }
    root.appendChild(evidence);

    toggle.addEventListener('click', () => {
      evidence.hidden = !evidence.hidden;
      toggle.textContent = evidence.hidden
        ? `Show ${p.evidence.length} evidence message${p.evidence.length === 1 ? '' : 's'}`
        : 'Hide evidence';
    });
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'secondary';
  rejectBtn.textContent = 'Reject';
  actions.appendChild(applyBtn);
  actions.appendChild(rejectBtn);
  root.appendChild(actions);

  const result = document.createElement('div');
  result.className = 'result';
  result.hidden = true;
  root.appendChild(result);

  applyBtn.addEventListener('click', () => applyCard(p.nick, textarea.value));
  rejectBtn.addEventListener('click', () => rejectCard(p.nick));

  return { root, textarea, applyBtn, rejectBtn, result };
}

async function applyCard(nick, note) {
  const entry = state.cards.get(nick);
  if (!entry) return;
  entry.card.applyBtn.disabled = true;
  entry.card.rejectBtn.disabled = true;
  try {
    const resp = await api('/api/apply', {
      method: 'POST',
      body: JSON.stringify({ scanId: state.scan.id, items: [{ nick, note }] }),
    });
    const r = resp.results?.[0];
    if (r?.ok) {
      entry.status = 'applied';
      entry.card.root.classList.add('applied');
      entry.card.result.hidden = false;
      entry.card.result.className = 'result ok';
      entry.card.result.textContent = 'Applied.';
    } else {
      entry.status = 'failed';
      entry.card.root.classList.add('failed');
      entry.card.result.hidden = false;
      entry.card.result.className = 'result err';
      entry.card.result.textContent = `Failed: ${r?.error || 'unknown error'}`;
      entry.card.applyBtn.disabled = false;
      entry.card.rejectBtn.disabled = false;
    }
  } catch (err) {
    entry.card.result.hidden = false;
    entry.card.result.className = 'result err';
    entry.card.result.textContent = err.message;
    entry.card.applyBtn.disabled = false;
    entry.card.rejectBtn.disabled = false;
  }
  updateApplyAll();
}

function rejectCard(nick) {
  const entry = state.cards.get(nick);
  if (!entry) return;
  entry.status = 'rejected';
  entry.card.root.classList.add('rejected');
  entry.card.applyBtn.disabled = true;
  entry.card.rejectBtn.disabled = true;
  entry.card.result.hidden = false;
  entry.card.result.className = 'result';
  entry.card.result.textContent = 'Rejected (not written).';
  updateApplyAll();
}

function updateApplyAll() {
  const remaining = [...state.cards.values()].filter((e) => e.status === 'pending');
  // Stay disabled while an apply-all loop is running — each applyCard() call
  // ends in updateApplyAll(), which would otherwise re-enable the button
  // mid-loop and allow a second, overlapping run.
  els.applyAll.disabled = remaining.length === 0 || state.isApplyingAll;
  els.applyAll.textContent =
    remaining.length === 0 ? 'Nothing left to apply' : `Apply all remaining (${remaining.length})`;
}

els.applyAll.addEventListener('click', async () => {
  const remaining = [...state.cards.values()].filter((e) => e.status === 'pending');
  if (remaining.length === 0 || state.isApplyingAll) return;
  state.isApplyingAll = true;
  els.applyAll.disabled = true;
  try {
    for (const entry of remaining) {
      // serial so the UI updates card-by-card and Lurker sees the writes in order
      await applyCard(entry.proposal.nick, entry.card.textarea.value);
    }
  } finally {
    state.isApplyingAll = false;
    updateApplyAll();
  }
});

// ---------------- helpers ----------------

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

route();
