// Home page: what needs attention today.
const $ = (s) => document.querySelector(s);
let ctx;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function card(title, extra, { wide = false } = {}) {
  const c = el('section', `today-card${wide ? ' wide' : ''}`);
  const h = el('h2', null, title);
  if (extra) h.append(el('span', 'muted', extra));
  c.append(h);
  return c;
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function eventsCard(t) {
  const c = card('Calendar', t.calendar ? `${t.calendar.length} today` : '');
  if (!t.calendar) {
    c.append(el('p', 'today-empty', 'Connect Google Calendar or add an ICS feed in Settings to see your day here.'));
    return c;
  }
  if (!t.calendar.length) { c.append(el('p', 'today-empty', 'Nothing on the calendar today.')); return c; }
  const ul = el('ul', 'today-list');
  const now = Date.now();
  for (const e of t.calendar) {
    const start = new Date(e.start).getTime();
    const end = new Date(e.end).getTime();
    const li = el('li', end < now ? 'past' : start <= now ? 'now' : '');
    li.append(el('span', 'when', e.allDay ? 'All day' : time(e.start)));
    const title = e.link ? Object.assign(el('a', null, e.title), { href: e.link, target: '_blank', rel: 'noopener' }) : el('span', null, e.title);
    li.append(title);
    const sub = [e.location, e.attendees?.length ? `${e.attendees.length} people` : '', e.calendar !== 'primary' ? e.calendar : ''].filter(Boolean).join(' · ');
    if (sub) li.append(el('span', 'sub', sub));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

function mailCard(t) {
  const c = card('Important unread mail', t.mail ? String(t.mail.length) : '');
  if (!t.mail) { c.append(el('p', 'today-empty', 'Connect Gmail in Settings to see mail that needs you.')); return c; }
  if (!t.mail.length) { c.append(el('p', 'today-empty', 'Nothing important unread.')); return c; }
  const ul = el('ul', 'today-list');
  for (const m of t.mail) {
    const li = el('li');
    li.append(el('span', 'when', (m.from || '').replace(/<.*>/, '').trim().slice(0, 18)));
    const a = Object.assign(el('a', null, m.subject || '(no subject)'), { href: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`, target: '_blank', rel: 'noopener' });
    li.append(a, el('span', 'sub', m.snippet || ''));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

function attentionCard(t) {
  const items = [...t.attention, ...t.working.map((w) => ({ ...w, kind: 'working', text: w.subagents ? `${w.subagents} subagent(s) running` : 'Working…' }))];
  const c = card('Chats that need you', items.length ? String(items.length) : '');
  if (!items.length) { c.append(el('p', 'today-empty', 'Nothing is waiting on you.')); return c; }
  const ul = el('ul', 'today-list');
  for (const a of items) {
    const li = el('li');
    li.append(el('span', `kind ${a.kind}`, a.kind));
    li.append(Object.assign(el('a', null, a.title), { href: `#/c/${a.id}` }), el('span', 'sub', a.text));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

function readingCard(t) {
  const c = card('Reading', '', { wide: true });
  if (!t.reading) {
    c.append(el('p', 'today-empty', 'Add RSS feeds or news topics under Settings → Sources for Today.'));
    return c;
  }
  for (const src of t.reading) {
    c.append(el('div', 'feed-name', src.name));
    if (!src.items.length) { c.append(el('p', 'today-empty', 'Nothing new.')); continue; }
    const ul = el('ul', 'today-list');
    for (const i of src.items) {
      const li = el('li');
      li.append(el('span', 'when', i.date ? new Date(i.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''));
      li.append(Object.assign(el('a', null, i.title), { href: i.link, target: '_blank', rel: 'noopener noreferrer' }));
      if (i.summary) li.append(el('span', 'sub', i.summary.slice(0, 160)));
      ul.append(li);
    }
    c.append(ul);
  }
  if (t.sources.feedErrors) c.append(el('p', 'today-empty', `Some sources failed: ${t.sources.feedErrors.join('; ')}`));
  return c;
}

function recentCard(t) {
  const c = card('Recent replies');
  if (!t.recent.length) { c.append(el('p', 'today-empty', 'No replies in the last day.')); return c; }
  const ul = el('ul', 'today-list');
  for (const r of t.recent) {
    const li = el('li');
    li.append(el('span', 'when', time(r.at)));
    li.append(Object.assign(el('a', null, r.title), { href: `#/c/${r.id}` }), el('span', 'sub', r.preview));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

export async function showToday() {
  const body = $('#today-body');
  $('#today-title').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  try {
    const t = await ctx.api('/api/today');
    body.replaceChildren(attentionCard(t), eventsCard(t), mailCard(t), recentCard(t), readingCard(t));
  } catch (e) {
    body.replaceChildren(el('p', 'muted', e.message));
  }
}

export function initToday(c) {
  ctx = c;
  $('#today-refresh').addEventListener('click', showToday);
  $('#today-brief').addEventListener('click', async () => {
    const b = $('#today-brief');
    b.disabled = true;
    try {
      const r = await ctx.api('/api/today/brief', { method: 'POST', body: {} });
      location.hash = `#/c/${r.id}`;
    } catch (e) { alert(e.message); } finally { b.disabled = false; }
  });
}
