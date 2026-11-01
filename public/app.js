import { renderMarkdown } from './markdown.js';
import { notify, permissionState, requestPermission } from './notify.js';
import { initFiles, showFiles } from './files.js';

const $ = (sel) => document.querySelector(sel);
const PROVIDER_LABEL = { anthropic: 'Claude', claudeCode: 'Claude Code', gemini: 'Gemini' };

const state = {
  settings: null,
  conversations: [],
  current: null, // full conversation object
  live: null, // { message, node, tools, body, abort } for the run being shown
  activeRuns: new Map(), // conversationId -> run summary (from /api/events)
  modelCache: {},
};

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- modal ---------- */

export function openModal({ title, sub = '', markdown = null, loading = false }) {
  $('#modal-title').textContent = title;
  $('#modal-sub').textContent = sub;
  const body = $('#modal-body');
  if (loading) body.textContent = 'Loading…';
  else body.innerHTML = renderMarkdown(markdown || '');
  const dlg = $('#modal');
  if (!dlg.open) dlg.showModal();
}

/* ---------- conversations ---------- */

async function refreshList() {
  state.conversations = await api('/api/conversations');
  renderList();
}

function renderList() {
  const list = $('#conv-list');
  list.replaceChildren(...state.conversations.map((c) => {
    const a = el('a', `conv-item${state.current?.id === c.id ? ' active' : ''}`);
    a.href = `#/c/${c.id}`;
    const title = el('span', 'conv-title', c.title || 'New chat');
    const run = state.activeRuns.get(c.id);
    if (run) {
      const subs = run.subagents.filter((s) => s.status === 'running').length;
      const badge = el('span', 'run-badge', subs ? `${subs} agent${subs > 1 ? 's' : ''}` : '');
      badge.title = subs ? `${subs} subagent${subs > 1 ? 's' : ''} running` : 'Working';
      a.append(el('span', 'spinner'), title, badge);
    } else {
      a.append(title);
    }
    a.append(el('small', null, [PROVIDER_LABEL[c.provider], c.model].filter(Boolean).join(' · ')));
    return a;
  }));
}

function setComposer(provider, model) {
  $('#provider-select').value = provider;
  $('#model-input').value = model ?? '';
  loadModelOptions(provider);
  updateProviderStatus();
}

function detachLive() {
  state.live?.abort?.abort();
  state.live = null;
}

function newChat() {
  detachLive();
  state.current = null;
  const p = state.settings.defaultProvider;
  setComposer(p, state.settings[p]?.model);
  renderAll();
  $('#chat-title').textContent = 'New chat';
  $('#rename-chat').hidden = $('#delete-chat').hidden = true;
  refreshList();
  $('#input').focus();
}

async function openConversation(id) {
  detachLive();
  try {
    state.current = await api(`/api/conversations/${id}`);
  } catch {
    location.hash = '#/';
    return;
  }
  setComposer(state.current.provider, state.current.model);
  $('#chat-title').textContent = state.current.title;
  $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  renderAll();
  renderList();
  if (state.current.running) attachStream(state.current);
}

/* ---------- rendering ---------- */

function toolNode(ev) {
  const d = el('details', 'tool');
  const s = el('summary');
  if (ev.type === 'tool') {
    s.append(el('b', null, ev.name), document.createTextNode(` ${ev.input || ''}`));
    d.append(s);
  } else {
    s.textContent = ev.isError ? 'Tool error' : 'Tool result';
    if (ev.isError) d.classList.add('err');
    d.append(s, el('pre', null, ev.text || '(empty)'));
  }
  return d;
}

/** A skill appears as a small chip; its full text opens in a modal. */
function skillNode(ev) {
  const b = el('button', 'skill-chip');
  b.type = 'button';
  b.dataset.skillId = ev.id;
  b.append(el('span', 'skill-icon', '✦'), el('span', null, `Skill: ${ev.name}`));
  if (ev.args) b.append(el('span', 'muted', ` ${ev.args}`));
  b.title = 'Show the skill text';
  b.addEventListener('click', () => {
    const text = b._skill?.text ?? ev.text;
    openModal({
      title: `Skill: ${ev.name}`,
      sub: b._skill?.path || ev.path || '',
      markdown: text ?? '_The skill text was not captured for this run._',
    });
  });
  b._skill = ev;
  return b;
}

function eventNode(ev) {
  return ev.type === 'skill' ? skillNode(ev) : toolNode(ev);
}

function upsertSkill(container, ev) {
  const existing = [...container.querySelectorAll('.skill-chip')].find((n) => n.dataset.skillId === ev.id);
  if (existing) existing._skill = { ...existing._skill, ...ev };
  else container.append(skillNode(ev));
}

function messageNode(m) {
  const wrap = el('div', `msg ${m.role}`);
  const who = m.role === 'user'
    ? (m.batch ? `You · ${m.batch.length} queued messages` : 'You')
    : [PROVIDER_LABEL[m.provider] || 'Assistant', m.model].filter(Boolean).join(' · ');
  wrap.append(el('div', 'who', who));
  const tools = el('div', 'tools');
  for (const ev of m.events || []) {
    if (ev.type === 'skill') upsertSkill(tools, ev);
    else tools.append(eventNode(ev));
  }
  wrap.append(tools);
  const body = el('div', 'body');
  if (m.role === 'user' && m.batch) {
    const ol = el('ol', 'batch');
    m.batch.forEach((t) => ol.append(el('li', null, t)));
    body.append(ol);
  } else if (m.role === 'user') body.textContent = m.content;
  else body.innerHTML = renderMarkdown(m.content);
  wrap.append(body);
  if (m.error) wrap.append(el('div', 'error', m.error));
  const meta = [];
  if (m.stopped) meta.push('stopped');
  if (m.usage?.input != null) meta.push(`${m.usage.input} in / ${m.usage.output ?? 0} out tokens`);
  if (m.costUsd != null) meta.push(`$${m.costUsd.toFixed(4)}`);
  if (meta.length) wrap.append(el('div', 'meta', meta.join(' · ')));
  return wrap;
}

function renderMessages() {
  const box = $('#messages');
  const empty = $('#empty-state');
  const msgs = state.current?.messages || [];
  box.replaceChildren(empty, ...msgs.map(messageNode));
  empty.hidden = msgs.length > 0;
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderMessages();
  renderSubagents();
  renderQueue();
  setBusy(Boolean(state.current?.running));
}

/* ---------- subagents ---------- */

let subagentsOpen = true;
let tick = null;

function elapsed(sa) {
  if (!sa.startedAt) return '';
  const end = sa.endedAt ? new Date(sa.endedAt) : new Date();
  const s = Math.max(0, Math.round((end - new Date(sa.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderSubagents() {
  const subs = state.current?.subagents || [];
  const panel = $('#subagents');
  panel.hidden = !subs.length;
  clearInterval(tick);
  if (!subs.length) return;
  const running = subs.filter((s) => s.status === 'running');
  const counts = ['running', 'done', 'failed', 'stopped']
    .map((st) => [st, subs.filter((s) => s.status === st).length]).filter(([, n]) => n);
  $('#subagents-summary').textContent = `Subagents · ${counts.map(([st, n]) => `${n} ${st}`).join(', ')}`;
  $('#subagents-toggle').setAttribute('aria-expanded', String(subagentsOpen));
  panel.classList.toggle('collapsed', !subagentsOpen);
  const order = { running: 0, failed: 1, stopped: 2, done: 3 };
  const sorted = [...subs].sort((a, b) => (order[a.status] - order[b.status]) || (b.startedAt || '').localeCompare(a.startedAt || ''));
  $('#subagent-list').replaceChildren(...sorted.map((sa) => {
    const li = el('li', `subagent ${sa.status}`);
    li.append(
      el('span', `pill ${sa.status}`, sa.status),
      el('span', 'sa-type', sa.agentType || 'subagent'),
      el('span', 'sa-desc', sa.description || ''),
    );
    const meta = [];
    if (sa.toolUses) meta.push(`${sa.toolUses} tool use${sa.toolUses > 1 ? 's' : ''}`);
    if (sa.background) meta.push('background');
    const time = el('span', 'sa-time', elapsed(sa));
    li.append(el('span', 'sa-meta muted', meta.join(' · ')), time);
    const detail = sa.status === 'running' ? sa.activity : sa.result;
    if (detail) li.append(el('div', 'sa-activity muted', detail));
    li._sa = sa;
    li._time = time;
    return li;
  }));
  if (running.length) {
    tick = setInterval(() => {
      for (const li of $('#subagent-list').children) if (li._sa.status === 'running') li._time.textContent = elapsed(li._sa);
    }, 1000);
  }
}

function applySubagent(sa) {
  if (!state.current) return;
  const list = (state.current.subagents ||= []);
  const i = list.findIndex((x) => x.id === sa.id);
  if (i >= 0) list[i] = sa; else list.push(sa);
  renderSubagents();
}

/* ---------- queue ---------- */

function renderQueue() {
  const box = $('#queue');
  const queue = state.current?.queue || [];
  box.hidden = !queue.length;
  if (!queue.length) { box.replaceChildren(); return; }
  const head = el('div', 'queue-head');
  head.append(el('span', null, `Queued · ${queue.length} message${queue.length > 1 ? 's' : ''} will go out together`));
  if (state.current.queuePaused || !state.current.running) {
    const send = el('button', 'btn small primary', 'Send now');
    send.type = 'button';
    send.addEventListener('click', () => queueAction('all', 'send'));
    head.append(el('span', 'muted', 'Paused after Stop'), send);
  } else {
    head.append(el('span', 'muted', 'after the current task'));
  }
  const items = queue.map((q) => {
    const row = el('div', 'queue-item');
    row.append(el('div', 'q-text', q.text));
    const t = q.triage || {};
    const status = el('div', 'q-triage');
    if (t.status === 'pending') status.append(el('span', 'muted', 'Checking whether this should interrupt…'));
    else if (t.decision === 'interrupt' && !t.dismissed && state.current.running) {
      status.classList.add('ask');
      status.append(el('span', null, `Suggests interrupting: ${t.reason || 'this looks urgent.'}`));
      const yes = el('button', 'btn small primary', 'Interrupt now');
      yes.type = 'button';
      yes.addEventListener('click', () => queueAction(q.id, 'send'));
      const no = el('button', 'btn small', 'Keep queued');
      no.type = 'button';
      no.addEventListener('click', () => queueAction(q.id, 'keep'));
      status.append(yes, no);
    } else if (t.status === 'done') {
      status.append(el('span', 'muted', t.decision === 'interrupt' ? 'Kept in the queue' : `Will wait${t.reason ? `: ${t.reason}` : ''}`));
    }
    const rm = el('button', 'btn ghost small', '✕');
    rm.type = 'button';
    rm.title = 'Remove from queue';
    rm.addEventListener('click', () => api(`/api/conversations/${state.current.id}/queue/${q.id}`, { method: 'DELETE' }));
    row.append(status, rm);
    return row;
  });
  box.replaceChildren(head, ...items);
}

async function queueAction(itemId, action) {
  if (!state.current) return;
  try {
    await api(`/api/conversations/${state.current.id}/queue/${itemId}/${action}`, { method: 'POST', body: {} });
    if (action === 'send' && !state.current.running) setTimeout(() => openConversation(state.current.id), 150);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- sending & streaming ---------- */

async function send(text) {
  const provider = $('#provider-select').value;
  const model = $('#model-input').value.trim();
  if (!state.current) {
    state.current = await api('/api/conversations', { method: 'POST', body: { provider, model } });
    history.replaceState(null, '', `#/c/${state.current.id}`);
    $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  }
  const conv = state.current;
  try {
    const r = await api(`/api/conversations/${conv.id}/messages`, { method: 'POST', body: { text, provider, model } });
    if (r.queued) {
      conv.queue = [...(conv.queue || []).filter((q) => q.id !== r.item.id), r.item];
      renderQueue();
      return;
    }
    // Reload so a paused queue merged into this turn shows up correctly.
    state.current = await api(`/api/conversations/${conv.id}`);
    renderAll();
    attachStream(state.current);
  } catch (e) {
    alert(e.message);
  }
  refreshList();
}

/** Follow the conversation's run: the server replays events so far, then streams live. */
async function attachStream(conv) {
  detachLive();
  const abort = new AbortController();
  const message = { role: 'assistant', content: '', provider: conv.provider, model: conv.model, events: [] };
  const node = messageNode(message);
  const tools = node.querySelector('.tools');
  const body = node.querySelector('.body');
  body.classList.add('typing');
  const box = $('#messages');
  box.append(node);
  $('#empty-state').hidden = true;
  state.live = { message, node, abort, convId: conv.id };
  conv.running = true;
  setBusy(true);

  const stick = () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight; };
  let pending = false;
  const paint = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; body.innerHTML = renderMarkdown(message.content); stick(); });
  };

  let finished = false;
  try {
    const res = await fetch(`/api/conversations/${conv.id}/stream`, { signal: abort.signal });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'idle') { finished = true; break; }
        if (ev.type === 'start') {
          conv.title = ev.conversation.title;
          $('#chat-title').textContent = conv.title;
        } else if (ev.type === 'text') {
          message.content += ev.text;
          paint();
        } else if (ev.type === 'tool' || ev.type === 'tool_result') {
          tools.append(toolNode(ev));
          stick();
        } else if (ev.type === 'skill') {
          upsertSkill(tools, ev);
        } else if (ev.type === 'subagent') {
          applySubagent(ev.subagent);
        } else if (ev.type === 'queue') {
          conv.queue = ev.queue;
          conv.queuePaused = ev.paused;
          renderQueue();
        } else if (ev.type === 'error') {
          message.error = ev.message;
        } else if (ev.type === 'done') {
          finished = true;
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // switched chats; the run keeps going on the server
    message.error = e.message;
  }
  if (state.live?.abort !== abort) return;
  state.live = null;
  // Reload the saved conversation: it has the final message, and maybe a new batched turn.
  if (state.current?.id === conv.id) {
    state.current = await api(`/api/conversations/${conv.id}`);
    renderAll();
    if (state.current.running) attachStream(state.current);
  }
  refreshList();
  void finished;
}

function setBusy(busy) {
  $('#stop').hidden = !busy;
  $('#running-label').hidden = !busy;
  $('#send').textContent = busy ? 'Queue' : 'Send';
  $('#send').title = busy ? 'Add to the queue; it is sent when the current task finishes' : '';
  $('#provider-select').disabled = busy;
  $('#model-input').disabled = busy;
  $('#input').placeholder = busy
    ? 'Working… you can keep typing. New messages are queued and sent together.'
    : 'Message… (Enter to send, Shift+Enter for a new line)';
}

/* ---------- live status across all chats (sidebar, notifications) ---------- */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'snapshot') {
      state.activeRuns = new Map(ev.runs.map((r) => [r.conversationId, r]));
      renderList();
      return;
    }
    if (ev.type === 'run') {
      if (ev.status === 'running') state.activeRuns.set(ev.conversationId, ev);
      else {
        state.activeRuns.delete(ev.conversationId);
        if (ev.status === 'done' || ev.status === 'error') {
          maybeNotify({
            title: ev.status === 'error' ? `Problem in “${ev.title}”` : `Reply ready: ${ev.title}`,
            body: ev.preview || '',
            conversationId: ev.conversationId,
          });
        }
      }
      if (!state.conversations.some((c) => c.id === ev.conversationId)) refreshList();
      else renderList();
      if (state.current?.id === ev.conversationId && ev.subagents) {
        for (const sa of ev.subagents) applySubagent(sa);
      }
    } else if (ev.type === 'queue') {
      if (state.current?.id === ev.conversationId) {
        state.current.queue = ev.queue;
        state.current.queuePaused = ev.paused;
        renderQueue();
      }
      const ask = ev.queue.find((q) => q.triage?.decision === 'interrupt' && !q.triage.dismissed && !q._notified);
      if (ask && state.activeRuns.has(ev.conversationId)) {
        const conv = state.conversations.find((c) => c.id === ev.conversationId);
        maybeNotify({
          title: `Interrupt “${conv?.title || 'chat'}”?`,
          body: `${ask.triage.reason || 'A new message looks urgent.'} Open the chat to decide.`,
          conversationId: ev.conversationId,
          tag: ask.id,
        });
      }
    }
  };
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

const notified = new Set();
function maybeNotify({ title, body, conversationId, tag }) {
  const n = state.settings.notifications;
  if (!n?.enabled) return;
  const key = tag || `${conversationId}:${title}`;
  if (tag) { if (notified.has(key)) return; notified.add(key); }
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  if (n.onlyWhenUnfocused && focused) return;
  notify({ title, body, conversationId, onClick: () => { location.hash = `#/c/${conversationId}`; } });
}

/* ---------- models & status ---------- */

async function loadModelOptions(provider, listId = 'model-options') {
  if (!state.modelCache[provider]) {
    state.modelCache[provider] = api(`/api/models/${provider}`).catch(() => ({ models: [] }));
  }
  const { models } = await state.modelCache[provider];
  const dl = document.getElementById(listId);
  if (listId === 'model-options' && $('#provider-select').value !== provider) return;
  dl.replaceChildren(...models.filter((m) => m.id).map((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = m.label;
    return o;
  }));
}

function updateProviderStatus() {
  const p = $('#provider-select').value;
  const dot = $('#provider-status');
  const s = state.settings?.[p];
  if (p === 'claudeCode') {
    dot.className = 'status-dot ok';
    dot.title = `Runs ${s?.binaryPath || 'claude'} in ${s?.workingDirectory || 'home directory'}`;
  } else if (s?.hasKey) {
    dot.className = 'status-dot ok';
    dot.title = `API key ${s.keyHint} (${s.keySource === 'env' ? 'from environment' : 'saved'})`;
  } else {
    dot.className = 'status-dot missing';
    dot.title = 'No API key yet. Add one in Settings.';
  }
}

/* ---------- settings ---------- */

const SECTIONS = ['anthropic', 'gemini', 'claudeCode', 'notifications', 'triage', 'google', 'calendars', 'tools', 'files'];

function fillSettingsForm() {
  const s = state.settings;
  const form = $('#settings-form');
  $('#data-dir').textContent = s.dataDir;
  form.elements.defaultProvider.value = s.defaultProvider;
  for (const p of SECTIONS) {
    for (const [k, v] of Object.entries(s[p] || {})) {
      const input = form.elements[`${p}.${k}`];
      if (!input || k === 'apiKey' || k === 'clientSecret') continue;
      if (input.type === 'checkbox') input.checked = Boolean(v);
      else input.value = v ?? '';
    }
  }
  for (const p of ['anthropic', 'gemini']) {
    const keyInput = form.elements[`${p}.apiKey`];
    keyInput.value = '';
    const badge = form.querySelector(`[data-provider="${p}"] .key-state`);
    if (s[p].hasKey) {
      badge.textContent = s[p].keySource === 'env' ? `using environment key ${s[p].keyHint}` : `saved ${s[p].keyHint}`;
      badge.className = 'key-state ok';
      keyInput.placeholder = 'Leave blank to keep the current key';
    } else {
      badge.textContent = 'not set';
      badge.className = 'key-state';
    }
    form.querySelector(`[data-clear="${p}"]`).hidden = s[p].keySource !== 'settings';
  }
  for (const p of ['anthropic', 'gemini', 'claudeCode']) loadModelOptions(p, `${p}-models`);
  form.elements['google.clientSecret'].value = '';
  $('#google-secret-state').textContent = s.google.hasClientSecret ? 'saved' : 'not set';
  $('#google-secret-state').className = `key-state${s.google.hasClientSecret ? ' ok' : ''}`;
  updateNotifyState();
  loadIntegrations();
}

async function loadIntegrations() {
  try {
    const r = await api('/api/integrations');
    $('#google-redirect').textContent = r.google.redirectUri;
    const st = $('#google-status');
    if (r.google.connected) {
      const on = ['calendar', 'gmail', 'drive'].filter((x) => r.google[x]);
      st.className = 'test-result ok';
      st.textContent = `Connected${r.google.email ? ` as ${r.google.email}` : ''} (${on.join(', ') || 'no services'})`;
      $('#google-connect').textContent = 'Reconnect';
      $('#google-disconnect').hidden = false;
    } else {
      st.className = 'test-result';
      st.textContent = 'Not connected';
      $('#google-connect').textContent = 'Connect Google';
      $('#google-disconnect').hidden = true;
    }
    const tools = r.tools.length ? `Tools the models can use now: ${r.tools.join(', ')}.` : 'No tools are connected yet.';
    const skills = r.skills.length
      ? ` Skills found for the API models: ${r.skills.map((x) => x.name).join(', ')}.`
      : ` No skills found in ${r.skillDirs.join(' or ')}. Claude Code uses its own skills either way.`;
    $('#tools-summary').textContent = tools + skills;
  } catch (e) {
    $('#tools-summary').textContent = e.message;
  }
}

function updateNotifyState() {
  const st = permissionState();
  $('#notify-state').textContent = {
    desktop: 'Desktop app: native notifications are on.',
    granted: 'Browser notifications are allowed.',
    denied: 'Blocked in this browser. Allow notifications for this site in your browser settings.',
    default: 'Your browser will ask for permission.',
    unsupported: 'This browser does not support notifications.',
  }[st];
  $('#notify-permission').hidden = st !== 'default';
}

function collectSettings() {
  const form = $('#settings-form');
  const patch = { defaultProvider: form.elements.defaultProvider.value };
  for (const input of form.querySelectorAll('[name*="."]')) {
    const [p, k] = input.name.split('.');
    patch[p] ||= {};
    patch[p][k] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return patch;
}

async function saveSettings(patch) {
  state.settings = await api('/api/settings', { method: 'PUT', body: patch });
  state.modelCache = {};
  fillSettingsForm();
  updateProviderStatus();
}

/* ---------- routing ---------- */

function route() {
  const hash = location.hash || '#/';
  $('#sidebar').classList.remove('open');
  const view = hash.startsWith('#/settings') ? 'settings' : hash.startsWith('#/files') ? 'files' : 'chat';
  $('#chat-view').hidden = view !== 'chat';
  $('#settings-view').hidden = view !== 'settings';
  $('#files-view').hidden = view !== 'files';
  $('#settings-link').classList.toggle('active', view === 'settings');
  $('#files-link').classList.toggle('active', view === 'files');
  if (view === 'settings') {
    fillSettingsForm();
    const q = new URLSearchParams(hash.split('?')[1] || '');
    if (q.get('google') === 'connected') {
      setTimeout(() => $('#google-card').scrollIntoView({ behavior: 'smooth' }), 50);
    }
    if (q.get('google_error')) alert(q.get('google_error'));
    return;
  }
  if (view === 'files') { showFiles(hash); return; }
  const m = hash.match(/^#\/c\/([\w-]+)/);
  if (m) {
    if (state.current?.id !== m[1]) openConversation(m[1]);
  } else {
    newChat();
  }
}

/* ---------- wiring ---------- */

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
}

async function init() {
  state.settings = await api('/api/settings');

  $('#new-chat').addEventListener('click', () => {
    if (location.hash === '#/' || location.hash === '') newChat();
    else location.hash = '#/';
  });

  const input = $('#input');
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize(input);
    send(text);
  });
  $('#stop').addEventListener('click', () => {
    if (state.current) api(`/api/conversations/${state.current.id}/stop`, { method: 'POST', body: {} });
  });

  $('#provider-select').addEventListener('change', () => {
    const p = $('#provider-select').value;
    $('#model-input').value = state.settings[p]?.model || '';
    loadModelOptions(p);
    updateProviderStatus();
  });

  $('#subagents-toggle').addEventListener('click', () => { subagentsOpen = !subagentsOpen; renderSubagents(); });

  $('#rename-chat').addEventListener('click', async () => {
    if (!state.current) return;
    const title = prompt('Rename chat', state.current.title);
    if (!title) return;
    const updated = await api(`/api/conversations/${state.current.id}`, { method: 'PATCH', body: { title } });
    state.current.title = updated.title;
    $('#chat-title').textContent = updated.title;
    refreshList();
  });
  $('#delete-chat').addEventListener('click', async () => {
    if (!state.current || !confirm('Delete this chat?')) return;
    detachLive();
    await api(`/api/conversations/${state.current.id}`, { method: 'DELETE' });
    state.current = null;
    location.hash = '#/';
    newChat();
  });

  for (const b of document.querySelectorAll('#toggle-sidebar, [data-toggle-sidebar]')) {
    b.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  }
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').close(); });

  const form = $('#settings-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('#save-result');
    try {
      await saveSettings(collectSettings());
      out.textContent = 'Saved.';
    } catch (err) {
      out.textContent = `Could not save: ${err.message}`;
    }
    setTimeout(() => { out.textContent = ''; }, 3000);
  });
  form.addEventListener('click', async (e) => {
    const testBtn = e.target.closest('[data-test]');
    const clearBtn = e.target.closest('[data-clear]');
    if (testBtn) {
      const p = testBtn.dataset.test;
      const out = form.querySelector(`[data-result="${p}"]`);
      out.className = 'test-result';
      out.textContent = 'Saving and testing…';
      testBtn.disabled = true;
      try {
        await saveSettings(collectSettings());
        const r = await api(`/api/test/${p}`, { method: 'POST', body: {} });
        out.className = `test-result ${r.ok ? 'ok' : 'fail'}`;
        out.textContent = r.message;
      } catch (err) {
        out.className = 'test-result fail';
        out.textContent = err.message;
      } finally {
        testBtn.disabled = false;
      }
    }
    if (clearBtn) {
      const p = clearBtn.dataset.clear;
      if (!confirm('Remove the saved API key?')) return;
      await saveSettings({ [p]: { clearApiKey: true } });
    }
  });

  $('#notify-permission').addEventListener('click', async () => { await requestPermission(); updateNotifyState(); });
  $('#notify-test').addEventListener('click', async () => {
    if (permissionState() === 'default') await requestPermission();
    updateNotifyState();
    notify({ title: 'Harness', body: 'Notifications are working.' });
  });

  $('#google-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#google-redirect').textContent));
  $('#google-connect').addEventListener('click', async () => {
    try {
      await saveSettings(collectSettings());
      if (!state.settings.google.clientId || !state.settings.google.hasClientSecret) {
        alert('Add your Google OAuth client ID and secret first.');
        return;
      }
      if (window.harnessDesktop) window.harnessDesktop.openExternal(`${location.origin}/api/google/auth`);
      else location.href = '/api/google/auth';
    } catch (err) { alert(err.message); }
  });
  $('#google-disconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect Google? The harness will forget its access token.')) return;
    await api('/api/google/disconnect', { method: 'POST', body: {} });
    loadIntegrations();
  });

  window.harnessDesktop?.onNavigate((hash) => { location.hash = hash; });

  initFiles({ api, el, openModal });
  window.addEventListener('hashchange', route);
  connectEvents();
  await refreshList();
  route();
}

init().catch((e) => {
  document.body.textContent = `Could not reach the harness server: ${e.message}`;
});
