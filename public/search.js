// Search boxes for conversations (sidebar) and settings (Settings page).
// Both are fuzzy; when nothing matches, they offer to ask Claude to find it.
import { fuzzyScore, fuzzyRank } from './fuzzy.js';

const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Text with each query word wrapped in <mark>, built as DOM nodes (no innerHTML). */
function highlighted(text, query) {
  const frag = document.createDocumentFragment();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) { frag.append(text); return frag; }
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  for (const part of String(text).split(re)) {
    if (!part) continue;
    if (words.includes(part.toLowerCase())) frag.append(el('mark', null, part));
    else frag.append(part);
  }
  return frag;
}

function askButton(label, onAsk) {
  const box = el('div', 'search-ask');
  const b = el('button', 'btn small', label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Asking Claude…';
    try { await onAsk(); } catch (e) { b.disabled = false; b.textContent = label; box.append(el('p', 'muted small', e.message)); }
  });
  box.append(b);
  return box;
}

/* ---------- conversations ---------- */

let ctx;
let convQuery = '';
let convResults = null; // server results for convQuery
let convAsk = null; // Claude's picks for convQuery
let convTimer = null;
let convSeq = 0;

export const convSearchActive = () => Boolean(convQuery);

function convRow(c, { why = '' } = {}) {
  const st = ctx.getState();
  const a = el('a', `conv-item search-result${st.current?.id === c.id ? ' active' : ''}`);
  a.href = `#/c/${c.id}`;
  const title = el('span', 'conv-title');
  title.append(highlighted(c.title || 'Untitled', convQuery));
  a.append(title);
  const meta = [st.projects.find((p) => p.id === c.projectId)?.name || 'Misc', c.updatedAt ? new Date(c.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''].filter(Boolean).join(' · ');
  a.append(el('span', 'muted small search-meta', meta));
  if (why) a.append(el('span', 'small search-why', `Claude: ${why}`));
  else if (c.snippet) { const s = el('span', 'small search-snippet'); s.append(highlighted(c.snippet, convQuery)); a.append(s); }
  return a;
}

export function renderConvSearch() {
  const list = $('#conv-list');
  const st = ctx.getState();
  const nodes = [];
  // Instant title matches from what the sidebar already has, until the server answers.
  const results = convResults ?? fuzzyRank(convQuery, st.conversations, (c) => [[c.title, 1]]).map((r) => r.item);
  nodes.push(el('div', 'muted small search-head', convResults ? `${results.length || 'No'} match${results.length === 1 ? '' : 'es'} in titles and messages` : 'Searching…'));
  for (const c of results) nodes.push(convRow(c));
  if (convResults && !results.length) {
    if (convAsk) {
      if (!convAsk.matches.length) nodes.push(el('p', 'muted small', convAsk.note || 'Claude didn\'t find a match either.'));
      for (const m of convAsk.matches) {
        const c = st.conversations.find((x) => x.id === m.id);
        if (c) nodes.push(convRow(c, { why: m.why || 'closest match' }));
      }
    } else {
      nodes.push(askButton('Ask Claude to find it', async () => {
        const q = convQuery;
        const r = await ctx.api('/api/search/ask', { method: 'POST', body: { kind: 'conversations', query: q } });
        if (q === convQuery) { convAsk = r; renderConvSearch(); }
      }));
    }
  }
  list.replaceChildren(...nodes);
}

function onConvInput(value) {
  convQuery = value.trim();
  convResults = null;
  convAsk = null;
  clearTimeout(convTimer);
  if (!convQuery) { ctx.rerender(); return; }
  renderConvSearch();
  const seq = ++convSeq;
  convTimer = setTimeout(async () => {
    try {
      const r = await ctx.api(`/api/search/conversations?q=${encodeURIComponent(convQuery)}`);
      if (seq === convSeq) { convResults = r.results; renderConvSearch(); }
    } catch { /* keep the title matches */ }
  }, 180);
}

/* ---------- settings ---------- */

let settingsIndex = null;

function buildSettingsIndex() {
  const form = $('#settings-form');
  const items = [];
  let n = 0;
  const id = (node) => { node.dataset.searchId ||= `s${++n}`; return node.dataset.searchId; };
  for (const fs of form.querySelectorAll('fieldset.card')) {
    const legend = fs.querySelector('legend')?.textContent.trim() || '';
    items.push({ node: fs, card: fs, id: id(fs), legend, text: legend, isCard: true });
    for (const f of fs.querySelectorAll('.field, label.check, .seg, .perm-row')) {
      const names = [...f.querySelectorAll('[name]')].map((x) => x.name.replace(/[.]/g, ' ')).join(' ');
      items.push({ node: f, card: fs, id: id(f), legend, text: `${f.textContent.replace(/\s+/g, ' ').trim()} ${names}` });
    }
  }
  // Fields outside any card (for example the default provider).
  for (const f of form.querySelectorAll(':scope > .field')) {
    items.push({ node: f, card: null, id: id(f), legend: '', text: f.textContent.replace(/\s+/g, ' ').trim() });
  }
  return items;
}

function clearSettingsFilter() {
  for (const x of document.querySelectorAll('#settings-form .search-hide, #settings-form .search-hit')) x.classList.remove('search-hide', 'search-hit');
  $('#settings-search-status').replaceChildren();
  $('#settings-form').classList.remove('searching');
}

function showOnly(hits) {
  const form = $('#settings-form');
  form.classList.add('searching');
  const cards = new Set(hits.map((h) => h.card).filter(Boolean));
  const wholeCards = new Set(hits.filter((h) => h.isCard).map((h) => h.node));
  for (const it of settingsIndex) {
    if (it.isCard) it.node.classList.toggle('search-hide', !cards.has(it.node));
    else if (!it.card) it.node.classList.toggle('search-hide', !hits.includes(it));
    else it.node.classList.toggle('search-hide', !wholeCards.has(it.card) && !hits.includes(it));
  }
  for (const p of form.querySelectorAll(':scope > p')) p.classList.add('search-hide');
  hits[0]?.node.classList.add('search-hit');
}

function onSettingsInput(value) {
  const q = value.trim();
  settingsIndex ||= buildSettingsIndex();
  clearSettingsFilter();
  if (!q) return;
  const status = $('#settings-search-status');
  const ranked = fuzzyRank(q, settingsIndex, (it) => [[it.text, 1], [it.legend, it.isCard ? 1.5 : 0.6]]);
  // Drop weak, scattered matches when there are strong ones.
  const hits = ranked.filter((r) => r.score >= ranked[0]?.score * 0.5).map((r) => r.item);
  if (hits.length) {
    showOnly(hits);
    status.append(el('span', 'muted small', `${hits.filter((h) => !h.isCard).length || hits.length} matching setting${hits.length === 1 ? '' : 's'}`));
    return;
  }
  showOnly([]);
  status.append(el('span', 'muted small', `No settings match "${q}".`), askButton('Ask Claude to find it', async () => {
    const candidates = settingsIndex.filter((it) => !it.isCard).map((it) => ({ id: it.id, text: `${it.legend ? `${it.legend} › ` : ''}${it.text}`.slice(0, 300) }));
    const r = await ctx.api('/api/search/ask', { method: 'POST', body: { kind: 'settings', query: q, candidates } });
    if ($('#settings-search').value.trim() !== q) return;
    const picks = r.matches.map((m) => ({ it: settingsIndex.find((x) => x.id === m.id), why: m.why })).filter((x) => x.it);
    status.replaceChildren();
    if (!picks.length) { status.append(el('span', 'muted small', r.note || 'Claude didn\'t find a matching setting either.')); return; }
    showOnly(picks.map((p) => p.it));
    status.append(el('span', 'muted small', `Claude suggests: ${picks.map((p) => `${p.it.legend || 'General'}${p.why ? ` (${p.why})` : ''}`).join('; ')}`));
    picks[0].it.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

/* ---------- wiring ---------- */

export function initSearch(c) {
  ctx = c;
  const conv = $('#conv-search');
  conv.addEventListener('input', () => onConvInput(conv.value));
  conv.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { conv.value = ''; onConvInput(''); conv.blur(); }
    if (e.key === 'Enter') { const first = $('#conv-list .search-result'); if (first) location.hash = first.getAttribute('href'); }
  });

  const set = $('#settings-search');
  set.addEventListener('input', () => onSettingsInput(set.value));
  set.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { set.value = ''; onSettingsInput(''); }
    if (e.key === 'Enter') e.preventDefault();
  });

  // ⌘K / Ctrl+K: search chats (or settings, on the Settings page).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const target = document.body.dataset.view === 'settings' ? set : conv;
      document.body.classList.remove('sidebar-collapsed');
      target.focus();
      target.select();
    }
  });
}

/** The Settings page can rebuild cards (MCP list, permissions); re-index on next search. */
export function settingsChanged() { settingsIndex = null; }

export { fuzzyScore };
