// Home → Briefing tab: the daily mail + calendar briefing with running action items.
const $ = (s) => document.querySelector(s);
let ctx;
let data = null;
let date = null; // null = today
let hideDone = true;
try { hideDone = localStorage.getItem('harness-briefing-hide-done') !== '0'; } catch { /* ignore */ }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, cls, onClick, title) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
const fmtDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const safeLink = (u) => (/^https:\/\//.test(u || '') ? u : '');

export async function showBriefing() {
  const box = $('#briefing-body');
  if (!data) box.replaceChildren(el('p', 'muted', 'Loading…'));
  try {
    data = await ctx.api(`/api/briefing${date ? `?date=${date}` : ''}`);
    render();
  } catch (e) { box.replaceChildren(el('p', 'muted', e.message)); }
}

function sectionTitle(id) {
  return data.config.sections.find((s) => s.id === id)?.title || data.day?.sections.find((s) => s.id === id)?.title || id;
}

function nav() {
  const bar = el('div', 'brief-bar');
  const days = data.days;
  const cur = data.day?.date || date || null;
  const i = cur ? days.indexOf(cur) : -1;
  const prev = btn('‹', 'btn ghost small', () => { date = days[i > 0 ? i - 1 : days.length - 1]; showBriefing(); }, 'Previous day');
  prev.disabled = !days.length || i === 0;
  const next = btn('›', 'btn ghost small', () => { date = days[i + 1]; showBriefing(); }, 'Next day');
  next.disabled = i < 0 || i >= days.length - 1;
  const label = el('strong', 'brief-day', cur ? fmtDay(cur) : 'Today');
  if (data.day?.backfilled) label.append(el('span', 'muted small', ' · filled in later'));
  bar.append(prev, label, next);
  if (date) bar.append(btn('Today', 'btn ghost small', () => { date = null; showBriefing(); }));
  const spacer = el('span', 'grow');
  const hide = el('label', 'small brief-hide');
  const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: hideDone });
  cb.addEventListener('change', () => { hideDone = cb.checked; try { localStorage.setItem('harness-briefing-hide-done', hideDone ? '1' : '0'); } catch { /* ignore */ } render(); });
  hide.append(cb, ' Hide done');
  const refresh = btn(data.status.running ? 'Updating…' : 'Check for new', 'btn ghost small', async () => {
    refresh.disabled = true; refresh.textContent = 'Updating…';
    try { await ctx.api('/api/briefing/refresh', { method: 'POST', body: {} }); } catch (e) { alert(e.message); }
    poll();
  });
  refresh.disabled = data.status.running;
  bar.append(spacer, hide, refresh, btn('Sections', 'btn ghost small', editSections));
  return bar;
}

function actionRow(a) {
  const li = el('li', `brief-action ${a.status}`);
  li.dataset.id = a.id;
  const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: a.status === 'done' });
  cb.setAttribute('aria-label', `Mark "${a.text}" ${a.status === 'done' ? 'open' : 'done'}`);
  cb.addEventListener('change', async () => {
    const status = cb.checked ? 'done' : 'open';
    a.status = status;
    li.classList.toggle('done', cb.checked);
    if (cb.checked && hideDone) { li.classList.add('fading'); setTimeout(render, 900); }
    try { await ctx.api(`/api/briefing/actions/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { date: data.day.date, status } }); } catch (e) { alert(e.message); showBriefing(); }
  });
  const main = el('div', 'brief-action-main');
  const text = el('span', 'brief-action-text', a.text);
  const link = safeLink(a.link);
  const meta = el('span', 'muted small');
  meta.textContent = [sectionTitle(a.section), a.due ? `due ${a.due}` : '', a.createdOn !== data.day.date ? `since ${a.createdOn}` : '', a.status === 'done' && a.doneBy === 'briefing' ? 'marked done from your mail' : ''].filter(Boolean).join(' · ');
  main.append(text);
  if (link) main.append(' ', Object.assign(el('a', 'small', 'open'), { href: link, target: '_blank', rel: 'noopener noreferrer' }));
  main.append(el('br'), meta);
  for (const n of a.notes || []) main.append(el('div', 'brief-note small', `${n.on}${n.by === 'you' ? '' : ' · briefing'}: ${n.text}`));
  const comment = btn('Comment', 'btn ghost tiny', () => {
    const f = el('form', 'brief-comment');
    const inp = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'Add a comment', required: true });
    f.append(inp, Object.assign(el('button', 'btn small', 'Add'), { type: 'submit' }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await ctx.api(`/api/briefing/actions/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { date: data.day.date, note: inp.value } }); showBriefing(); } catch (err) { alert(err.message); }
    });
    comment.replaceWith(f);
    inp.focus();
  });
  main.append(comment);
  li.append(cb, main);
  return li;
}

function actionsCard() {
  const c = el('section', 'today-card wide');
  const all = data.day.actions;
  const open = all.filter((a) => a.status !== 'done');
  const h = el('h2', null, 'Action items');
  h.append(el('span', 'muted', `${open.length} open${all.length > open.length ? ` · ${all.length - open.length} done` : ''}`));
  c.append(h);
  const ul = el('ul', 'brief-actions');
  const shown = hideDone ? open : all;
  for (const a of shown) ul.append(actionRow(a));
  if (!shown.length) ul.append(el('li', 'today-empty', all.length ? 'All done.' : 'No action items yet.'));
  c.append(ul);
  const f = el('form', 'brief-add');
  const inp = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'New to-do', required: true });
  const sel = document.createElement('select');
  for (const s of data.config.sections) sel.append(Object.assign(document.createElement('option'), { value: s.id, textContent: s.title }));
  sel.value = 'other';
  f.append(inp, sel, Object.assign(el('button', 'btn small', 'Add'), { type: 'submit' }));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await ctx.api('/api/briefing/actions', { method: 'POST', body: { date: data.day.date, text: inp.value, section: sel.value } }); showBriefing(); } catch (err) { alert(err.message); }
  });
  c.append(f);
  return c;
}

function sectionCard(sec) {
  const c = el('section', 'today-card');
  const h = el('h2', null, sec.title);
  h.append(el('span', 'muted', String(sec.items.length)));
  c.append(h);
  const ul = el('ul', 'today-list');
  for (const it of sec.items) {
    const li = el('li');
    const link = safeLink(it.link);
    const head = link ? Object.assign(el('a', null, it.headline), { href: link, target: '_blank', rel: 'noopener noreferrer' }) : el('strong', null, it.headline);
    li.append(head);
    if (it.detail) li.append(el('div', 'muted small', it.detail));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

function render() {
  const box = $('#briefing-body');
  const parts = [nav()];
  const st = data.status;
  if (st.running) parts.push(el('p', 'brief-status', `${st.step || 'Working'}…`));
  if (st.error) parts.push(el('p', 'today-empty', `Last update failed: ${st.error}`));
  const day = data.day;
  if (!day) {
    parts.push(el('p', 'today-empty', st.running ? 'Reading your mail and calendar for today. This takes a minute.' : 'No briefing for this day yet.'));
    if (st.running) poll();
    box.replaceChildren(...parts);
    return;
  }
  for (const e of day.errors || []) parts.push(el('p', 'today-empty', e));
  if (day.summary) parts.push(el('p', 'brief-summary', day.summary));
  const grid = el('div', 'today');
  grid.append(actionsCard());
  const order = data.config.sections.map((s) => s.id);
  const secs = [...day.sections].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  for (const s of secs) if (s.items.length) grid.append(sectionCard(s));
  const empty = secs.filter((s) => !s.items.length).map((s) => s.title);
  if (empty.length) grid.append(el('p', 'muted small wide-note', `Nothing new in ${empty.join(', ')}.`));
  parts.push(grid);
  if (day.generatedAt) parts.push(el('p', 'muted small', `Updated ${new Date(day.generatedAt).toLocaleString()} · saved in ${data.dir}`));
  box.replaceChildren(...parts);
  if (st.running) poll();
}

let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (document.body.dataset.view !== 'today') return;
    await showBriefing();
  }, 4000);
}

function editSections() {
  const dlg = el('dialog', 'brief-sections');
  const list = el('div', 'brief-sec-list');
  const row = (s) => {
    const r = el('div', 'brief-sec-row');
    const t = Object.assign(document.createElement('input'), { type: 'text', value: s.title, placeholder: 'Title' });
    const d = Object.assign(document.createElement('input'), { type: 'text', value: s.description || '', placeholder: 'What goes here' });
    r.append(t, d);
    r._get = () => ({ id: s.id, title: t.value, description: d.value, fixed: s.fixed });
    if (!s.fixed) r.append(btn('Remove', 'btn ghost tiny', () => r.remove()));
    else r.append(el('span', 'muted tiny', 'always on'));
    return r;
  };
  const fill = (secs) => list.replaceChildren(...secs.map(row));
  fill(data.config.sections);
  const add = btn('Add section', 'btn ghost small', () => list.insertBefore(row({ id: '', title: '', description: '' }), list.querySelector('.brief-sec-row:has(.tiny.muted)')));
  const suggest = btn('Suggest from last week', 'btn ghost small', async () => {
    suggest.disabled = true; suggest.textContent = 'Thinking…';
    try { fill((await ctx.api('/api/briefing/sections/suggest', { method: 'POST', body: {} })).sections); } catch (e) { alert(e.message); }
    suggest.disabled = false; suggest.textContent = 'Suggest from last week';
  });
  const save = btn('Save', 'btn primary small', async () => {
    const sections = [...list.children].map((r) => r._get()).filter((s) => s.title.trim());
    try { await ctx.api('/api/briefing/sections', { method: 'PUT', body: { sections } }); dlg.close(); showBriefing(); } catch (e) { alert(e.message); }
  });
  const foot = el('div', 'brief-sec-foot');
  foot.append(add, suggest, el('span', 'grow'), btn('Cancel', 'btn ghost small', () => dlg.close()), save);
  dlg.append(el('h2', null, 'Briefing sections'), el('p', 'muted small', 'New mail and calendar items are sorted into these. Changes apply from the next update.'), list, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

export function briefingUpdated() {
  if (document.body.dataset.view === 'today' && !$('#briefing-body').hidden) showBriefing();
}

export function initBriefing(c) { ctx = c; }
