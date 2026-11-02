// Conversation extras: code copy buttons, long-prompt folding, artifacts, branching,
// context donut, input history, pasted images, and conversation tabs.
import { renderMarkdown } from './markdown.js';

const $ = (s) => document.querySelector(s);
let ctx;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1200); }
  } catch { /* clipboard blocked */ }
}

/* ---------- message bodies ---------- */

/** Adds a Copy button to each code block in a rendered message. */
export function enhanceBody(body) {
  for (const pre of body.querySelectorAll('pre')) {
    if (pre.querySelector('.code-copy')) continue;
    const b = el('button', 'code-copy', 'Copy');
    b.type = 'button';
    b.addEventListener('click', () => copy(pre.querySelector('code')?.textContent ?? pre.textContent.replace(/Copy(ied)?$/, ''), b));
    pre.append(b);
  }
}

const FOLD_LINES = 15;

/** A user message: long ones show 15 lines with "Show all"; a Copy button re-copies it. */
export function userBody(body, text) {
  body.textContent = text;
  const lines = String(text).split('\n').length;
  if (lines > FOLD_LINES) {
    body.classList.add('folded');
    body.style.setProperty('--fold-lines', FOLD_LINES);
    const more = el('button', 'fold-toggle', `Show all ${lines} lines`);
    more.type = 'button';
    more.addEventListener('click', () => {
      const open = body.classList.toggle('folded');
      more.textContent = open ? `Show all ${lines} lines` : 'Show less';
    });
    body.after(more);
  }
}

export function userActions(text) {
  const bar = el('div', 'msg-actions');
  const c = el('button', 'btn ghost tiny', 'Copy');
  c.type = 'button';
  c.title = 'Copy this message to the clipboard';
  c.addEventListener('click', () => copy(text, c));
  bar.append(c);
  return bar;
}

export function imageStrip(paths) {
  const strip = el('div', 'image-strip');
  for (const p of paths) {
    const img = el('img');
    img.src = `/api/uploads/file?path=${encodeURIComponent(p)}`;
    img.alt = 'Attached image';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(img.src, '_blank'));
    strip.append(img);
  }
  return strip;
}

/* ---------- artifacts ---------- */

const PREVIEWABLE = /\.(html?|md|markdown|txt|svg|json|csv)$/i;

/** Files the agent wrote or edited, as chips that open a viewer. */
export function artifactChips(events) {
  const seen = new Set();
  const files = [];
  for (const ev of events || []) {
    if (ev.type === 'tool' && ev.path && !seen.has(ev.path)) { seen.add(ev.path); files.push(ev); }
  }
  if (!files.length) return null;
  const box = el('div', 'artifacts');
  for (const f of files) box.append(artifactChip(f));
  return box;
}

export function artifactChip(ev) {
  const name = ev.path.split(/[\\/]/).pop();
  const b = el('button', 'artifact-chip');
  b.type = 'button';
  b.title = ev.path;
  b.append(el('span', 'artifact-icon', /\.html?$/i.test(name) ? '🌐' : /\.md$/i.test(name) ? '📝' : '📄'), el('span', null, name), el('span', 'muted', ev.name === 'Write' ? ' created' : ' edited'));
  if (PREVIEWABLE.test(name)) b.addEventListener('click', () => openArtifact(ev.path));
  else b.disabled = true;
  return b;
}

export async function openArtifact(path) {
  const dlg = $('#artifact');
  const frame = $('#artifact-frame');
  const md = $('#artifact-md');
  $('#artifact-title').textContent = path.split(/[\\/]/).pop();
  $('#artifact-path').textContent = path;
  const src = `/api/artifact?path=${encodeURIComponent(path)}`;
  $('#artifact-open').onclick = () => window.open(src, '_blank');
  $('#artifact-copy').onclick = (e) => copy(path, e.currentTarget);
  if (/\.(html?|svg)$/i.test(path)) {
    md.hidden = true;
    frame.hidden = false;
    frame.src = src;
  } else {
    frame.hidden = true;
    frame.removeAttribute('src');
    md.hidden = false;
    md.textContent = 'Loading…';
    try {
      const r = await ctx.api(`${src}&format=json`);
      if (r.kind === 'md' || r.kind === 'markdown') { md.innerHTML = renderMarkdown(r.content); enhanceBody(md); } else { md.replaceChildren(el('pre', null, r.content)); }
    } catch (e) { md.textContent = e.message; }
  }
  if (!dlg.open) dlg.showModal();
}

/* ---------- branching (right-click a turn) ---------- */

let menu;
export function attachTurnMenu(node, index) {
  node.addEventListener('contextmenu', (e) => {
    const conv = ctx.current();
    if (!conv?.id) return;
    e.preventDefault();
    menu?.remove();
    menu = el('div', 'context-menu');
    const item = (label, fn) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', () => { menu.remove(); fn(); });
      menu.append(b);
    };
    item('Branch from here', () => branch(conv.id, index));
    item('Copy text', () => copy(conv.messages[index]?.content || ''));
    document.body.append(menu);
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`;
    setTimeout(() => document.addEventListener('click', () => menu?.remove(), { once: true }));
  });
}

export async function branch(id, index) {
  try {
    const r = await ctx.api(`/api/conversations/${id}/branch`, { method: 'POST', body: { index } });
    location.hash = `#/c/${r.id}`;
  } catch (e) { alert(e.message); }
}

/* ---------- context donut ---------- */

export function renderDonut(context) {
  const d = $('#context-donut');
  if (!context?.used || !context?.limit) { d.hidden = true; return; }
  const pct = Math.min(1, context.used / context.limit);
  d.hidden = false;
  d.style.setProperty('--pct', `${Math.round(pct * 100)}`);
  d.classList.toggle('warn', pct >= 0.7 && pct < 0.9);
  d.classList.toggle('bad', pct >= 0.9);
  d.title = `Context: about ${Math.round(context.used / 1000)}k of ${Math.round(context.limit / 1000)}k tokens (${Math.round(pct * 100)}%)`;
  d.setAttribute('aria-label', d.title);
}

/* ---------- input history (↑ / ↓) ---------- */

let histIndex = -1;
let draft = '';
function pastInputs() {
  const conv = ctx.current();
  return (conv?.messages || []).filter((m) => m.role === 'user').flatMap((m) => (m.batch ? m.batch : [m.content])).filter(Boolean);
}
export function resetHistory() { histIndex = -1; draft = ''; }

function onHistoryKey(e) {
  const input = e.target;
  if (!$('#mention-pop').hidden || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length;
  const list = pastInputs();
  if (e.key === 'ArrowUp' && (atStart || !input.value || histIndex >= 0) && !input.value.slice(0, input.selectionStart).includes('\n')) {
    if (!list.length) return;
    e.preventDefault();
    if (histIndex < 0) { draft = input.value; histIndex = list.length; }
    histIndex = Math.max(0, histIndex - 1);
    input.value = list[histIndex];
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new Event('input'));
  } else if (e.key === 'ArrowDown' && histIndex >= 0 && atEnd) {
    e.preventDefault();
    histIndex += 1;
    if (histIndex >= list.length) { input.value = draft; histIndex = -1; } else input.value = list[histIndex];
    input.dispatchEvent(new Event('input'));
  }
}

/* ---------- pasted / picked files ---------- */

export const pending = { images: [] };

function renderTray() {
  const tray = $('#attach-tray');
  tray.hidden = !pending.images.length;
  tray.replaceChildren(...pending.images.map((p, i) => {
    const wrap = el('span', 'tray-item');
    const img = el('img');
    img.src = `/api/uploads/file?path=${encodeURIComponent(p)}`;
    img.alt = 'Pasted image';
    const x = el('button', 'tray-x', '✕');
    x.type = 'button';
    x.title = 'Remove';
    x.addEventListener('click', () => { pending.images.splice(i, 1); renderTray(); });
    wrap.append(img, x);
    return wrap;
  }));
}
export function clearTray() { pending.images = []; renderTray(); }

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(file);
});

async function addFile(file) {
  const isImage = file.type.startsWith('image/');
  const saved = await ctx.api('/api/uploads', { method: 'POST', body: { name: file.name || (isImage ? 'pasted.png' : 'pasted.txt'), data: await toBase64(file) } });
  if (isImage) { pending.images.push(saved.path); renderTray(); } else insertText(`@${/\s/.test(saved.path) ? `"${saved.path}"` : saved.path} `);
}

function insertText(t) {
  const input = $('#input');
  const s = input.selectionStart;
  const before = input.value.slice(0, s);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  input.value = before + pad + t + input.value.slice(input.selectionEnd);
  const pos = s + pad.length + t.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event('input'));
}

/** 📎: the system file picker. The desktop app inserts real paths; the browser uploads a copy. */
async function pickFiles() {
  const desk = window.harnessDesktop;
  if (desk?.pickFiles) {
    const paths = await desk.pickFiles();
    for (const p of paths || []) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(p)) insertText(`@${/\s/.test(p) ? `"${p}"` : p} `);
      else insertText(`@${/\s/.test(p) ? `"${p}"` : p} `);
    }
    return;
  }
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', async () => { for (const f of input.files) { try { await addFile(f); } catch (e) { alert(e.message); } } });
  input.click();
}

/* ---------- tabs ---------- */

const TABS_KEY = 'harness-tabs';
let tabs = [];
try { tabs = JSON.parse(localStorage.getItem(TABS_KEY) || '[]'); } catch { tabs = []; }
const saveTabs = () => { try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* ignore */ } };

export function openTab(id) {
  if (!tabs.includes(id)) { tabs.push(id); saveTabs(); }
  try { localStorage.setItem('harness-last-tab', id); } catch { /* ignore */ }
  renderTabs();
}
export function lastTab() {
  try { const id = localStorage.getItem('harness-last-tab'); if (id && tabs.includes(id)) return id; } catch { /* ignore */ }
  return tabs.at(-1) || null;
}
function closeTab(id) {
  const i = tabs.indexOf(id);
  if (i < 0) return;
  tabs.splice(i, 1);
  saveTabs();
  if (ctx.current()?.id === id) location.hash = tabs.length ? `#/c/${tabs[Math.min(i, tabs.length - 1)]}` : '#/';
  renderTabs();
}
export function renderTabs() {
  const bar = $('#tabs');
  const convs = ctx.conversations();
  const known = new Set(convs.map((c) => c.id));
  // Drop tabs for deleted chats (keep the open one even if the list hasn't caught up).
  const cur = ctx.current()?.id;
  if (convs.length) { const before = tabs.length; tabs = tabs.filter((t) => known.has(t) || t === cur); if (tabs.length !== before) saveTabs(); }
  bar.hidden = !tabs.length || document.body.dataset.view !== 'chat' || document.body.classList.contains('solo');
  bar.replaceChildren(...tabs.map((id) => {
    const c = convs.find((x) => x.id === id) || (cur === id ? ctx.current() : null);
    const t = el('a', `tab${id === cur ? ' active' : ''}${c?.unread ? ' unread' : ''}${c?.running ? ' running' : ''}${c?.needsYou ? ' needs-you' : ''}`);
    t.href = `#/c/${id}`;
    t.title = c?.title || '';
    t.append(el('span', 'tab-dot'), el('span', 'tab-title', c?.title || 'Chat'));
    const x = el('button', 'tab-x', '✕');
    x.type = 'button';
    x.title = 'Close tab';
    x.setAttribute('aria-label', 'Close tab');
    x.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeTab(id); });
    t.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
    t.append(x);
    return t;
  }));
}

/* ---------- init ---------- */

export function initChatExtras(c) {
  ctx = c;
  const input = $('#input');
  input.addEventListener('keydown', onHistoryKey);
  input.addEventListener('input', () => { if (!input.value) resetHistory(); });
  input.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) { try { await addFile(f); } catch (err) { alert(err.message); } }
  });
  input.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) { try { await addFile(f); } catch (err) { alert(err.message); } }
  });
  $('#attach').addEventListener('click', pickFiles);
  $('#attach').title = 'Attach files (or type @ for project files)';
}
