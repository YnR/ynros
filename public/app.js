import { renderMarkdown } from './markdown.js';
import { notify, permissionState, requestPermission } from './notify.js';
import { initFiles, showFiles } from './files.js';
import { renderSidebar, initSidebarCollapse } from './sidebar.js';
import { initMentions } from './mentions.js';
import { initToday, showToday } from './today.js';
import { briefingUpdated } from './briefing.js';
import { initSearch, convSearchActive, renderConvSearch } from './search.js';
import { initSettingsExtra, applyTheme, loadMcp, fillQuota, collectQuota } from './settings-extra.js';
import { initAutomations, fillHomeAssistant } from './automations.js';
import { initHistory } from './history.js';
import {
  initChatExtras, enhanceBody, userBody, userActions, imageStrip, artifactChips, artifactChip, attachTurnMenu,
  renderDonut, resetHistory, pending as composerPending, clearTray, openTab, renderTabs, lastTab,
} from './chat-extras.js';
import { initPermissions } from './permissions.js';

const $ = (sel) => document.querySelector(sel);
const PROVIDER_LABEL = { anthropic: 'Claude', claudeCode: 'Claude Code', gemini: 'Gemini' };

const state = {
  settings: null,
  conversations: [],
  current: null, // full conversation object
  live: null, // { message, node, tools, body, abort } for the run being shown
  activeRuns: new Map(), // conversationId -> run summary (from /api/events)
  modelCache: {},
  projects: [],
  projectId: null, // project for the next new chat
  quota: {},
};
window.harnessState = state;
let sidebarCtl;

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
  const [convs, proj] = await Promise.all([
    api('/api/conversations'),
    api('/api/projects').catch(() => ({ projects: [] })),
  ]);
  state.conversations = convs;
  state.projects = proj.projects;
  state.hostFolder = proj.hostFolder;
  renderList();
}

/** Unread replies and chats waiting for an answer: window title, dock badge, sidebar. */
function updateBadge() {
  const n = state.conversations.filter((c) => (c.unread && c.id !== visibleChatId()) || c.needsYou).length;
  document.title = n ? `(${n}) Harness` : 'Harness';
  window.harnessDesktop?.setBadge?.(n);
}
const visibleChatId = () => (document.visibilityState === 'visible' && document.body.dataset.view === 'chat' ? state.current?.id : null);

/** Marks the open chat as read once its reply is on screen. */
async function markRead() {
  const c = state.current;
  if (!c?.id || c.running || visibleChatId() !== c.id) return;
  const entry = state.conversations.find((x) => x.id === c.id);
  if (entry && !entry.unread) return;
  try {
    await api(`/api/conversations/${c.id}/read`, { method: 'POST', body: {} });
    if (entry) entry.unread = false;
    renderList();
  } catch { /* offline */ }
}

function renderList() {
  renderTabs();
  updateBadge();
  if (convSearchActive()) { renderConvSearch(); return; }
  renderSidebar($('#conv-list'), {
    perGroup: state.settings?.projects?.chatsPerGroup || 3,
    onSolo: (href) => openSolo(href),
    projects: state.projects,
    conversations: state.conversations,
    currentId: state.current?.id,
    activeRuns: state.activeRuns,
    onNew: (projectId) => { location.hash = projectId ? `#/new/${projectId}` : '#/new'; },
  });
}

function projectName(id) {
  return state.projects.find((p) => p.id === id)?.name || null;
}

function showProjectBadge(id) {
  const badge = $('#chat-project');
  const move = $('#move-chat');
  const name = projectName(id);
  // An open chat gets a picker to move it between projects; a new chat just shows where it will go.
  if (state.current) {
    badge.hidden = true;
    move.hidden = false;
    move.replaceChildren(
      new Option('📁 Misc', ''),
      ...state.projects.map((p) => new Option(`📁 ${p.name}`, p.id)),
    );
    move.value = state.projects.some((p) => p.id === id) ? id : '';
  } else {
    move.hidden = true;
    badge.hidden = !name;
    badge.textContent = name ? `📁 ${name}` : '';
  }
}

async function moveChat(projectId) {
  if (!state.current) return;
  try {
    const c = await api(`/api/conversations/${state.current.id}`, { method: 'PATCH', body: { projectId: projectId || null } });
    state.current.projectId = c.projectId;
    state.projectId = c.projectId;
    refreshList();
  } catch (e) {
    alert(e.message);
    showProjectBadge(state.current.projectId);
  }
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

function defaultModel(p) {
  return state.settings.routing?.enabled !== false ? 'auto' : state.settings[p]?.model;
}

function newChat(projectId = null) {
  detachLive();
  state.current = null;
  state.projectId = projectId;
  showProjectBadge(projectId);
  const p = state.settings.defaultProvider;
  setComposer(p, defaultModel(p));
  renderAll();
  clearTray();
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
  state.projectId = state.current.projectId || null;
  showProjectBadge(state.current.projectId);
  $('#chat-title').textContent = state.current.title;
  $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  openTab(id);
  resetHistory();
  clearTray();
  renderAll();
  renderList();
  if (state.current.running) attachStream(state.current);
  else markRead();
}

/* ---------- rendering ---------- */

function toolNode(ev) {
  if (ev.type === 'notice') return el('div', `notice ${ev.kind || ''}`, ev.text);
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

function messageNode(m, index = -1, { cleared = false } = {}) {
  if (m.role === 'system') {
    const n = el('div', `divider ${m.kind || ''}`, m.kind === 'clear' ? 'Context cleared with /clear. The model does not see the turns above.' : (m.text || ''));
    return n;
  }
  const wrap = el('div', `msg ${m.role}${cleared ? ' cleared' : ''}`);
  if (index >= 0) { wrap.dataset.index = String(index); attachTurnMenu(wrap, index); }
  const who = m.role === 'user'
    ? (m.batch ? `You · ${m.batch.length} queued messages` : 'You')
    : [PROVIDER_LABEL[m.provider] || 'Assistant', m.model].filter(Boolean).join(' · ');
  const whoEl = el('div', 'who', who);
  if (m.routed) whoEl.append(el('span', 'routed muted', ` · auto: ${m.routed.tier}`));
  if (m.routed?.reason) whoEl.title = m.routed.reason;
  wrap.append(whoEl);
  if (m.attachments?.length) {
    const at = el('div', 'attachments');
    m.attachments.forEach((a) => at.append(el('span', 'attachment', `@${a}`)));
    wrap.append(at);
  }
  if (m.images?.length) wrap.append(imageStrip(m.images));
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
    wrap.append(body);
  } else if (m.role === 'user') {
    wrap.append(body);
    userBody(body, m.content);
  } else {
    body.innerHTML = renderMarkdown(m.content);
    enhanceBody(body);
    wrap.append(body);
  }
  const arts = artifactChips(m.events);
  if (arts) wrap.append(arts);
  if (m.error) wrap.append(el('div', 'error', m.error));
  const meta = [];
  if (m.stopped) meta.push('stopped');
  if (m.usage?.input != null) meta.push(`${m.usage.input} in / ${m.usage.output ?? 0} out tokens`);
  // Claude Code reports the cost of each turn (one CLI run), not a running total.
  if (m.costUsd != null) meta.push(`$${m.costUsd.toFixed(3)} this turn`);
  if (meta.length) {
    const metaEl = el('div', 'meta', meta.join(' · '));
    if (m.costUsd != null) metaEl.title = `This turn only. Chat total so far: $${chatCost().toFixed(3)}`;
    wrap.append(metaEl);
  }
  if (m.role === 'user') wrap.append(userActions(m.content));
  return wrap;
}

const chatCost = () => (state.current?.messages || []).reduce((s, m) => s + (m.costUsd || 0), 0);

function renderMessages() {
  const box = $('#messages');
  const empty = $('#empty-state');
  const msgs = state.current?.messages || [];
  // Turns before the last /clear are dimmed: the model no longer sees them.
  let lastClear = -1;
  msgs.forEach((m, i) => { if (m.role === 'system' && m.kind === 'clear') lastClear = i; });
  const intro = [];
  if (state.current?.branchedFrom) {
    const b = el('div', 'divider branch');
    b.append(document.createTextNode('Branched from '));
    const a = el('a', null, state.current.branchedFrom.title || 'another chat');
    a.href = `#/c/${state.current.branchedFrom.id}`;
    b.append(a);
    intro.push(b);
  }
  box.replaceChildren(empty, ...intro, ...msgs.map((m, i) => messageNode(m, i, { cleared: i < lastClear })));
  empty.hidden = msgs.length > 0;
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderDonut(state.current?.context);
  renderMessages();
  renderSubagents();
  renderQueue();
  renderBanners();
  setBusy(Boolean(state.current?.running));
}

/* ---------- banners: usage limits, fresh-chat suggestion ---------- */

function bannerButton(label, onClick, primary = false) {
  const b = el('button', `btn small${primary ? ' primary' : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function switchProvider(provider, model) {
  if (!state.current) {
    setComposer(provider, model ?? defaultModel(provider));
    renderBanners();
    return;
  }
  await api(`/api/conversations/${state.current.id}/switch`, { method: 'POST', body: { provider, model: model ?? defaultModel(provider) } });
  setTimeout(() => openConversation(state.current.id), 200);
}

function renderBanners() {
  const box = $('#banners');
  const out = [];
  const conv = state.current;
  const hold = conv?.quotaHold;
  if (hold) {
    const b = el('div', `banner ${hold.reason === 'exhausted' ? 'bad' : 'warn'}`);
    const when = hold.resetsAt ? ` until about ${fmtTime(hold.resetsAt)}` : '';
    const text = hold.reason === 'exhausted'
      ? `${hold.label} is out of quota${when}. Waiting work will resume on its own then.`
      : `${hold.label} is at ${Math.round((hold.utilization || 0) * 100)}% of its limit. Queued work is on hold to keep the last ${hold.reservePercent ?? 5}% for your new instructions.`;
    b.append(el('span', 'grow', text));
    for (const alt of hold.alternatives || []) b.append(bannerButton(`Switch to ${alt.label}`, () => switchProvider(alt.provider), true));
    b.append(bannerButton(hold.reason === 'exhausted' ? 'Try now' : 'Send anyway', () => queueAction('all', 'send')));
    out.push(b);
  } else {
    // Running low on the provider picked in the composer.
    const p = $('#provider-select').value;
    const q = state.quota[p];
    if (q && (q.exhausted || q.low)) {
      const b = el('div', `banner ${q.exhausted ? 'bad' : 'warn'}`);
      const text = q.exhausted
        ? `${q.label} is out of quota${q.resetsAt ? ` until about ${fmtTime(q.resetsAt)}` : ''}. Messages will wait for the reset.`
        : `${q.label} is running low${q.utilization != null ? ` (${Math.round(q.utilization * 100)}% used)` : ''}.`;
      b.append(el('span', 'grow', text));
      for (const alt of q.alternatives || []) b.append(bannerButton(`Switch to ${alt.label}`, () => switchProvider(alt.provider), true));
      out.push(b);
    }
  }
  if (conv?.suggestNewChat) {
    const b = el('div', 'banner warn');
    b.append(el('span', 'grow', `This looks like a new topic${conv.suggestNewChat.reason ? ` (${conv.suggestNewChat.reason})` : ''}. A fresh chat avoids re-sending this chat's history and saves tokens.`));
    b.append(bannerButton('Move to a new chat', async () => {
      const r = await api(`/api/conversations/${conv.id}/new-chat`, { method: 'POST', body: {} });
      location.hash = `#/c/${r.id}`;
    }, true));
    b.append(bannerButton('Keep here', async () => {
      await api(`/api/conversations/${conv.id}/dismiss-suggestion`, { method: 'POST', body: {} });
      conv.suggestNewChat = null;
      renderBanners();
    }));
    out.push(b);
  }
  box.replaceChildren(...out);
}

async function refreshQuota() {
  try { state.quota = await api('/api/quota'); } catch { state.quota = {}; }
  renderBanners();
}

/* ---------- approvals ---------- */

function approvalNode(ev) {
  const d = el('div', `approval${ev.status === 'pending' ? '' : ' done'}`);
  d.dataset.approvalId = ev.id;
  const text = el('span', 'grow');
  text.append(document.createTextNode(ev.status === 'pending' ? 'Wants to use ' : ev.status === 'allowed' ? 'Allowed ' : 'Denied '));
  text.append(el('b', null, ev.tool));
  if (ev.summary) text.append(document.createTextNode(': '), el('code', null, ev.summary));
  d.append(text);
  if (ev.status === 'pending') {
    const answer = (allow, always = false) => api(`/api/approvals/${ev.id}`, { method: 'POST', body: { allow, always } }).catch((e) => alert(e.message));
    const alwaysBtn = bannerButton('Always allow', () => answer(true, true));
    alwaysBtn.title = `Allow ${ev.rule || ev.tool} in this project from now on`;
    d.append(bannerButton('Allow', () => answer(true), true), alwaysBtn, bannerButton('Deny', () => answer(false)));
  } else if (ev.note) {
    d.append(el('span', 'muted small', ev.note));
  }
  return d;
}

function upsertApproval(container, ev) {
  const existing = container.querySelector(`[data-approval-id="${ev.id}"]`);
  const node = approvalNode(ev);
  if (existing) existing.replaceWith(node); else container.append(node);
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

const DISMISS_KEY = 'harness-subagents-dismissed';
function dismissedAt(id) { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}')[id] || ''; } catch { return ''; } }
function setDismissed(id) {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
    all[id] = new Date().toISOString();
    localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** A subagent's own activity (tool calls and messages), opened from the panel. */
function showSubagentLog(sa) {
  const lines = (sa.log || []).map((l) => (l.kind === 'tool' ? `- \`${l.text.replace(/`/g, "'")}\`` : `\n${l.text}\n`));
  openModal({
    title: `${sa.agentType || 'Subagent'}: ${sa.description || ''}`,
    sub: [sa.status, sa.toolUses ? `${sa.toolUses} tool uses` : '', elapsed(sa)].filter(Boolean).join(' · '),
    markdown: [lines.join('\n') || '_No activity recorded yet._', sa.result ? `\n---\n**Result**\n\n${sa.result}` : ''].join('\n'),
  });
}

function renderSubagents() {
  const since = dismissedAt(state.current?.id);
  // Finished subagents stay until dismissed; a new one brings the panel back.
  const subs = (state.current?.subagents || []).filter((s) => s.status === 'running' || !since || (s.startedAt || '') > since);
  const bg = (state.current?.background || []).filter((t) => t.status === 'running' || !t.endedAt || Date.now() - Date.parse(t.endedAt) < 10_000);
  const panel = $('#subagents');
  panel.hidden = !subs.length && !bg.length;
  clearInterval(tick);
  if (!subs.length && !bg.length) return;
  const running = subs.filter((s) => s.status === 'running');
  const counts = ['running', 'done', 'failed', 'stopped']
    .map((st) => [st, subs.filter((s) => s.status === st).length]).filter(([, n]) => n);
  const total = subs.length;
  const finished = total - running.length;
  // A deterministic indicator: agents dispatched vs. closed.
  $('#subagents-summary').textContent = `${total ? `Subagents · ${finished}/${total} finished${counts.length ? ` (${counts.map(([st, n]) => `${n} ${st}`).join(', ')})` : ''}` : ''}${bg.length ? `${total ? ' · ' : ''}${bg.filter((t) => t.status === 'running').length} background task${bg.length > 1 ? 's' : ''}` : ''}`;
  const prog = $('#subagents-progress');
  prog.hidden = !total;
  prog.max = total || 1;
  prog.value = finished;
  const dismiss = $('#subagents-dismiss');
  dismiss.hidden = Boolean(running.length) || !total;
  $('#subagents-toggle').setAttribute('aria-expanded', String(subagentsOpen));
  panel.classList.toggle('collapsed', !subagentsOpen);
  const order = { running: 0, failed: 1, stopped: 2, done: 3 };
  const sorted = [...subs].sort((a, b) => (order[a.status] - order[b.status]) || (b.startedAt || '').localeCompare(a.startedAt || ''));
  const bgNodes = bg.map((t) => {
    const li = el('li', `subagent background-task ${t.status}${t.status !== 'running' ? ' fading' : ''}`);
    li.append(el('span', `pill ${t.status === 'detached' ? 'stopped' : t.status}`, t.status === 'detached' ? 'ended' : t.status), el('span', 'sa-type', t.taskType === 'local_bash' ? 'shell' : t.taskType || 'task'), el('span', 'sa-desc', t.description || ''));
    const time = el('span', 'sa-time', elapsed(t));
    li.append(el('span', 'sa-meta muted', 'background'), time);
    if (t.result) li.append(el('div', 'sa-activity muted', t.result));
    li._sa = t;
    li._time = time;
    return li;
  });
  $('#subagent-list').replaceChildren(...bgNodes, ...sorted.map((sa) => {
    const li = el('li', `subagent ${sa.status}`);
    li.tabIndex = 0;
    li.title = 'Show what this subagent did';
    li.addEventListener('click', () => showSubagentLog(sa));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') showSubagentLog(sa); });
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
  if (running.length || bg.length) {
    tick = setInterval(() => {
      for (const li of $('#subagent-list').children) if (li._sa.status === 'running') li._time.textContent = elapsed(li._sa);
      // Finished background tasks fade out over 10 seconds, then leave the list.
      if (bg.some((t) => t.status !== 'running' && t.endedAt && Date.now() - Date.parse(t.endedAt) >= 10_000)) renderSubagents();
    }, 1000);
  }
}

function applyBackground(task) {
  if (!state.current) return;
  const list = (state.current.background ||= []);
  const i = list.findIndex((x) => x.id === task.id);
  if (i >= 0) list[i] = task; else list.push(task);
  renderSubagents();
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
    if (t.status === 'pending') status.append(el('span', 'muted', 'Checking what to do with this…'));
    else if (t.status === 'done' && !t.dismissed && state.current.running) {
      // The triage model recommends one of four options; the user decides with one click.
      const label = { interrupt: 'Interrupt now', queue: 'Wait (keep queued)', parallel: 'Run in parallel', new: 'New chat' };
      const what = { interrupt: 'Suggests interrupting', queue: 'Suggests waiting', parallel: 'Suggests running it in parallel (a branch with this context)', new: 'Suggests a fresh chat (unrelated topic)' };
      status.classList.toggle('ask', t.decision !== 'queue');
      status.append(el('span', null, `${what[t.decision] || what.queue}${t.reason ? `: ${t.reason}` : ''}`));
      const opts = el('div', 'q-options');
      for (const d of [t.decision, ...['queue', 'interrupt', 'parallel', 'new'].filter((x) => x !== t.decision)]) {
        const b = el('button', `btn small${d === t.decision ? ' primary' : ''}`, label[d]);
        b.type = 'button';
        b.addEventListener('click', () => queueAction(q.id, d === 'interrupt' ? 'send' : d === 'queue' ? 'keep' : d));
        opts.append(b);
      }
      status.append(opts);
    } else if (t.status === 'done') {
      status.append(el('span', 'muted', `Will wait${t.reason ? `: ${t.reason}` : ''}`));
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
    const r = await api(`/api/conversations/${state.current.id}/queue/${itemId}/${action}`, { method: 'POST', body: {} });
    if ((action === 'parallel' || action === 'new') && r.id) { openTab(r.id); refreshList(); return; }
    if (action === 'send' && !state.current.running) setTimeout(() => openConversation(state.current.id), 150);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- sending & streaming ---------- */

async function send(text) {
  const provider = $('#provider-select').value;
  const model = $('#model-input').value.trim();
  const images = [...composerPending.images];
  clearTray();
  if (!state.current) {
    state.current = await api('/api/conversations', { method: 'POST', body: { provider, model, projectId: state.projectId } });
    history.replaceState(null, '', `#/c/${state.current.id}`);
    openTab(state.current.id);
    $('#rename-chat').hidden = $('#delete-chat').hidden = false;
  }
  const conv = state.current;
  try {
    const r = await api(`/api/conversations/${conv.id}/messages`, { method: 'POST', body: { text, provider, model, images } });
    if (r.cleared) {
      state.current = await api(`/api/conversations/${conv.id}`);
      renderAll();
      return;
    }
    if (r.queued) {
      conv.queue = [...(conv.queue || []).filter((q) => q.id !== r.item.id), r.item];
      if (r.quotaHold) conv.quotaHold = r.quotaHold;
      renderQueue();
      renderBanners();
      refreshList();
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
    requestAnimationFrame(() => { pending = false; body.innerHTML = renderMarkdown(message.content); enhanceBody(body); stick(); });
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
        } else if (ev.type === 'tool' || ev.type === 'tool_result' || ev.type === 'notice') {
          tools.append(toolNode(ev));
          if (ev.path) {
            let arts = node.querySelector('.artifacts');
            if (!arts) { arts = el('div', 'artifacts'); body.after(arts); }
            if (![...arts.children].some((c) => c.title === ev.path)) arts.append(artifactChip(ev));
          }
          stick();
        } else if (ev.type === 'background') {
          applyBackground(ev.task);
        } else if (ev.type === 'context') {
          conv.context = { used: ev.used, limit: ev.limit };
          renderDonut(conv.context);
        } else if (ev.type === 'skill') {
          upsertSkill(tools, ev);
        } else if (ev.type === 'subagent') {
          applySubagent(ev.subagent);
        } else if (ev.type === 'status') {
          node.querySelector('.who').textContent = ev.text;
        } else if (ev.type === 'routed') {
          message.model = ev.model;
          message.routed = { tier: ev.tier, reason: ev.reason };
          const who = node.querySelector('.who');
          who.textContent = [PROVIDER_LABEL[message.provider], ev.model].filter(Boolean).join(' · ');
          who.append(el('span', 'routed muted', ` · auto: ${ev.tier}`));
          who.title = ev.reason || '';
        } else if (ev.type === 'suggest_new_chat') {
          conv.suggestNewChat = { reason: ev.reason };
          renderBanners();
        } else if (ev.type === 'approval') {
          upsertApproval(tools, ev);
          stick();
        } else if (ev.type === 'queue') {
          conv.queue = ev.queue;
          conv.queuePaused = ev.paused;
          conv.quotaHold = ev.quotaHold;
          renderQueue();
          renderBanners();
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
  await refreshList();
  markRead();
  void finished;
}

function setBusy(busy) {
  $('#composer').classList.toggle('working', busy);
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
      if (ev.status !== 'running') refreshQuota();
      if (!state.conversations.some((c) => c.id === ev.conversationId)) refreshList();
      else renderList();
      if (state.current?.id === ev.conversationId && ev.subagents) {
        for (const sa of ev.subagents) applySubagent(sa);
      }
    } else if (ev.type === 'quota') {
      refreshQuota();
    } else if (ev.type === 'history' || ev.type === 'read') {
      if (ev.type === 'read') {
        const c = state.conversations.find((x) => x.id === ev.conversationId);
        if (c) { c.unread = false; c.readAt = ev.readAt; renderList(); }
      } else refreshList();
    } else if (ev.type === 'briefing') {
      briefingUpdated();
    } else if (ev.type === 'news') {
      setNewsFlag(ev.unread);
    } else if (ev.type === 'automation' && ev.status === 'notify') {
      const n = state.settings.notifications;
      // Automations are explicit requests: notify even when the window has focus.
      if (n?.enabled) notify({ title: ev.title, body: ev.message || '', conversationId: ev.conversationId, onClick: () => { if (ev.conversationId) location.hash = `#/c/${ev.conversationId}`; } });
    } else if (ev.type === 'approval') {
      const c = state.conversations.find((x) => x.id === ev.conversationId);
      if (c) { c.needsYou = ev.status === 'pending'; renderList(); }
      if (ev.status === 'pending') {
        const conv = state.conversations.find((c) => c.id === ev.conversationId);
        maybeNotify({
          title: `Approval needed: ${conv?.title || 'chat'}`,
          body: `${ev.tool}${ev.summary ? `: ${ev.summary}` : ''}`,
          conversationId: ev.conversationId,
          tag: ev.id,
        });
      }
    } else if (ev.type === 'queue') {
      if (state.current?.id === ev.conversationId) {
        state.current.queue = ev.queue;
        state.current.queuePaused = ev.paused;
        state.current.quotaHold = ev.quotaHold;
        renderQueue();
        renderBanners();
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
  const opts = models.filter((m) => m.id).map((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = m.label;
    return o;
  });
  if (listId === 'model-options') {
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.label = 'Pick the right model for each message';
    opts.unshift(auto);
  }
  dl.replaceChildren(...opts);
}

function updateProviderStatus() {
  renderBanners();
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

const SECTIONS = ['history', 'permissions', 'desktop', 'anthropic', 'gemini', 'claudeCode', 'notifications', 'triage', 'google', 'calendars', 'tools', 'files', 'projects', 'contacts', 'routing', 'quota', 'appearance', 'sources', 'homeAssistant'];

function fillSettingsForm() {
  const s = state.settings;
  const form = $('#settings-form');
  $('#data-dir').textContent = s.dataDir;
  form.elements.defaultProvider.value = s.defaultProvider;
  for (const p of SECTIONS) {
    for (const [k, v] of Object.entries(s[p] || {})) {
      const input = form.elements[`${p}.${k}`];
      if (!input || k === 'apiKey' || k === 'clientSecret' || k === 'token' || (v && typeof v === 'object')) continue;
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
  if (!s.projects.hostFolder) form.elements['projects.hostFolder'].placeholder = state.hostFolder || '~/src';
  applyTheme(s.appearance?.theme);
  fillQuota(s);
  fillHomeAssistant(s);
  loadMcp();
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
  collectQuota(patch);
  return patch;
}

async function saveSettings(patch) {
  state.settings = await api('/api/settings', { method: 'PUT', body: patch });
  window.harnessDesktop?.setOpenAtLogin?.(Boolean(state.settings.desktop?.openAtLogin));
  state.modelCache = {};
  fillSettingsForm();
  updateProviderStatus();
}

/* ---------- routing ---------- */

function route() {
  const hash = location.hash || '#/';
  $('#sidebar').classList.remove('open');
  const view = hash.startsWith('#/settings') ? 'settings'
    : hash.startsWith('#/files') ? 'files'
      : hash.startsWith('#/c/') || hash.startsWith('#/new') ? 'chat' : 'today';
  for (const v of ['chat', 'settings', 'files', 'today']) $(`#${v}-view`).hidden = view !== v;
  document.body.dataset.view = view;
  renderTabs();
  $('#conversations-link').classList.toggle('active', view === 'chat');
  $('#settings-link').classList.toggle('active', view === 'settings');
  $('#files-link').classList.toggle('active', view === 'files');
  $('#today-link').classList.toggle('active', view === 'today');
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
  if (view === 'today') { detachLive(); state.current = null; renderList(); showToday(); return; }
  if (hash === '#/c' || hash === '#/c/') { const t = lastTab(); location.hash = t ? `#/c/${t}` : '#/new'; return; }
  const m = hash.match(/^#\/c\/([\w-]+)/);
  if (m) {
    if (state.current?.id !== m[1]) openConversation(m[1]);
    return;
  }
  const np = hash.match(/^#\/new\/([\w-]+)/);
  newChat(np ? np[1] : null);
}

/* ---------- wiring ---------- */

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
}

async function init() {
  state.settings = await api('/api/settings');

  $('#new-chat').addEventListener('click', () => {
    if (location.hash === '#/new') newChat();
    else location.hash = '#/new';
  });
  sidebarCtl = initSidebarCollapse();
  applyTheme(state.settings.appearance?.theme);

  // Projects
  $('#project-new').addEventListener('click', () => {
    $('#project-host').textContent = `It will be created in ${state.settings.projects?.hostFolder || state.hostFolder || '~/src'} with a CLAUDE.md and an outputs folder.`;
    $('#project-result').textContent = '';
    $('#project-form').reset();
    $('#project-dialog').showModal();
  });
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const p = await api('/api/projects', { method: 'POST', body: { name: f.name.value, existingPath: f.existingPath.value || undefined } });
      $('#project-dialog').close();
      await refreshList();
      location.hash = `#/new/${p.id}`;
    } catch (err) {
      $('#project-result').className = 'test-result fail';
      $('#project-result').textContent = err.message;
    }
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
    b.addEventListener('click', () => sidebarCtl.show());
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
  initMentions({ api, current: () => state.current, projectId: () => state.projectId });
  initToday({ api });
  initSearch({ api, getState: () => state, rerender: () => renderList() });
  initSettingsExtra({ api, save: saveSettings });
  initAutomations({ api, save: saveSettings, collect: collectSettings });
  initHistory({ api, refreshList });
  initChatExtras({ api, current: () => state.current, conversations: () => state.conversations });
  initPermissions({ api, projects: () => state.projects });
  // Shift-click (or ?solo) opens one chat alone in its own window.
  if (new URLSearchParams(location.search).has('solo')) document.body.classList.add('solo', 'sidebar-collapsed');
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markRead(); updateBadge(); });
  window.addEventListener('focus', markRead);
  $('#artifact').addEventListener('click', (e) => { if (e.target === $('#artifact')) $('#artifact').close(); });
  $('#subagents-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.current) return;
    setDismissed(state.current.id);
    renderSubagents();
  });
  api('/api/news').then((r) => setNewsFlag(r.unread)).catch(() => {});
  $('#move-chat').addEventListener('change', (e) => moveChat(e.target.value));
  refreshQuota();
  window.addEventListener('hashchange', route);
  connectEvents();
  await refreshList();
  route();
}

function openSolo(href) {
  const url = `${location.origin}/?solo=1${href}`;
  if (window.harnessDesktop?.openWindow) window.harnessDesktop.openWindow(url);
  else window.open(url, '_blank', 'popup,width=900,height=900');
}

/** A dot on Today when the News tab has unread articles. */
export function setNewsFlag(n) {
  const link = $('#today-link');
  link.classList.toggle('has-news', n > 0);
  link.title = n > 0 ? `${n} new article${n > 1 ? 's' : ''} in News` : '';
}
window.harnessSetNewsFlag = setNewsFlag;

init().catch((e) => {
  document.body.textContent = `Could not reach the harness server: ${e.message}`;
});
