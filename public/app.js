import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const PROVIDER_LABEL = { anthropic: 'Claude', claudeCode: 'Claude Code', gemini: 'Gemini' };

const state = {
  settings: null,
  conversations: [],
  current: null, // full conversation object
  streaming: null, // AbortController
  modelCache: {},
};

async function api(path, opts = {}) {
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

/* ---------- conversations ---------- */

async function refreshList() {
  state.conversations = await api('/api/conversations');
  const list = $('#conv-list');
  list.replaceChildren(...state.conversations.map((c) => {
    const a = document.createElement('a');
    a.className = 'conv-item' + (state.current?.id === c.id ? ' active' : '');
    a.href = `#/c/${c.id}`;
    a.textContent = c.title || 'New chat';
    const small = document.createElement('small');
    small.textContent = [PROVIDER_LABEL[c.provider], c.model].filter(Boolean).join(' · ');
    a.append(small);
    return a;
  }));
}

function setComposer(provider, model) {
  $('#provider-select').value = provider;
  $('#model-input').value = model ?? '';
  loadModelOptions(provider);
  updateProviderStatus();
}

function newChat() {
  state.current = null;
  const p = state.settings.defaultProvider;
  setComposer(p, state.settings[p]?.model);
  renderMessages();
  $('#chat-title').textContent = 'New chat';
  $('#rename-chat').hidden = $('#delete-chat').hidden = true;
  refreshList();
  $('#input').focus();
}

async function openConversation(id) {
  try {
    state.current = await api(`/api/conversations/${id}`);
  } catch {
    location.hash = '#/';
    return;
  }
  setComposer(state.current.provider, state.current.model);
  $('#chat-title').textContent = state.current.title;
  $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  renderMessages();
  refreshList();
}

/* ---------- rendering ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function toolNode(ev) {
  const d = el('details', 'tool');
  const s = el('summary');
  if (ev.type === 'tool') {
    s.append(el('b', null, ev.name), document.createTextNode(` ${ev.input || ''}`));
    d.append(s);
  } else {
    s.textContent = ev.isError ? 'Tool error' : 'Tool result';
    d.append(s, el('pre', null, ev.text || '(empty)'));
  }
  return d;
}

function messageNode(m) {
  const wrap = el('div', `msg ${m.role}`);
  const who = m.role === 'user' ? 'You' : [PROVIDER_LABEL[m.provider] || 'Assistant', m.model].filter(Boolean).join(' · ');
  wrap.append(el('div', 'who', who));
  if (m.events?.length) {
    const tools = el('div', 'tools');
    m.events.forEach((ev) => tools.append(toolNode(ev)));
    wrap.append(tools);
  }
  const body = el('div', 'body');
  if (m.role === 'user') body.textContent = m.content;
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
  const msgs = state.current?.messages || [];
  if (!msgs.length) {
    box.replaceChildren($('#empty-state') || el('div'));
    $('#empty-state').hidden = false;
    return;
  }
  const empty = $('#empty-state');
  box.replaceChildren(...msgs.map(messageNode));
  if (empty) { empty.hidden = true; box.prepend(empty); }
  box.scrollTop = box.scrollHeight;
}

/* ---------- sending ---------- */

async function send(text) {
  const provider = $('#provider-select').value;
  const model = $('#model-input').value.trim();
  if (!state.current) {
    state.current = await api('/api/conversations', { method: 'POST', body: { provider, model } });
    history.replaceState(null, '', `#/c/${state.current.id}`);
    $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  }
  const conv = state.current;
  conv.messages.push({ role: 'user', content: text });
  const live = { role: 'assistant', content: '', provider, model, events: [] };
  conv.messages.push(live);
  renderMessages();

  const box = $('#messages');
  const node = box.lastElementChild;
  const body = node.querySelector('.body');
  const tools = el('div', 'tools');
  node.insertBefore(tools, body);
  body.classList.add('typing');

  const controller = new AbortController();
  state.streaming = controller;
  setBusy(true);

  const stickToBottom = () => {
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  };
  let pending = false;
  const paint = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; body.innerHTML = renderMarkdown(live.content); stickToBottom(); });
  };

  try {
    const res = await fetch(`/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, provider, model }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
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
        if (ev.type === 'start') {
          conv.title = ev.conversation.title;
          $('#chat-title').textContent = conv.title;
        } else if (ev.type === 'text') {
          live.content += ev.text;
          paint();
        } else if (ev.type === 'tool' || ev.type === 'tool_result') {
          tools.append(toolNode(ev));
          stickToBottom();
        } else if (ev.type === 'error') {
          live.error = ev.message;
        } else if (ev.type === 'done') {
          Object.assign(live, ev.message);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') live.stopped = true;
    else live.error = e.message;
  } finally {
    state.streaming = null;
    setBusy(false);
    renderMessages();
    refreshList();
  }
}

function setBusy(busy) {
  $('#send').hidden = busy;
  $('#stop').hidden = !busy;
  $('#provider-select').disabled = busy;
  $('#model-input').disabled = busy;
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

function fillSettingsForm() {
  const s = state.settings;
  const form = $('#settings-form');
  $('#data-dir').textContent = s.dataDir;
  form.elements.defaultProvider.value = s.defaultProvider;
  for (const p of ['anthropic', 'gemini', 'claudeCode']) {
    for (const [k, v] of Object.entries(s[p])) {
      const input = form.elements[`${p}.${k}`];
      if (input && k !== 'apiKey') input.value = v ?? '';
    }
    const keyInput = form.elements[`${p}.apiKey`];
    if (keyInput) {
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
    loadModelOptions(p, `${p}-models`);
  }
}

function collectSettings() {
  const form = $('#settings-form');
  const patch = { defaultProvider: form.elements.defaultProvider.value, anthropic: {}, gemini: {}, claudeCode: {} };
  for (const input of form.querySelectorAll('[name*="."]')) {
    const [p, k] = input.name.split('.');
    patch[p][k] = input.value;
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
  const isSettings = hash.startsWith('#/settings');
  $('#chat-view').hidden = isSettings;
  $('#settings-view').hidden = !isSettings;
  $('#settings-link').classList.toggle('active', isSettings);
  if (isSettings) { fillSettingsForm(); return; }
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
    if (!text || state.streaming) return;
    input.value = '';
    autosize(input);
    send(text);
  });
  $('#stop').addEventListener('click', () => state.streaming?.abort());

  $('#provider-select').addEventListener('change', () => {
    const p = $('#provider-select').value;
    $('#model-input').value = state.settings[p]?.model || '';
    loadModelOptions(p);
    updateProviderStatus();
  });

  $('#rename-chat').addEventListener('click', async () => {
    if (!state.current) return;
    const title = prompt('Rename chat', state.current.title);
    if (!title) return;
    state.current = await api(`/api/conversations/${state.current.id}`, { method: 'PATCH', body: { title } });
    $('#chat-title').textContent = state.current.title;
    refreshList();
  });
  $('#delete-chat').addEventListener('click', async () => {
    if (!state.current || !confirm('Delete this chat?')) return;
    await api(`/api/conversations/${state.current.id}`, { method: 'DELETE' });
    state.current = null;
    location.hash = '#/';
    newChat();
  });

  for (const b of document.querySelectorAll('#toggle-sidebar, [data-toggle-sidebar]')) {
    b.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  }

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

  window.addEventListener('hashchange', route);
  await refreshList();
  route();
}

init().catch((e) => {
  document.body.textContent = `Could not reach the harness server: ${e.message}`;
});
