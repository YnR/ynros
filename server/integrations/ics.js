/**
 * Read-only calendars from ICS feed URLs (Outlook, iCloud, Fastmail, a Google
 * "secret address", …). Supports the common recurrence rules
 * (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY) and EXDATE.
 */

export function parseFeeds(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line, i) => {
    const m = line.match(/^(.*?)\s*\|\s*(\S+)$/);
    const url = (m ? m[2] : line).replace(/^webcal:/i, 'https:');
    const name = m ? m[1] : (() => { try { return new URL(url).hostname; } catch { return `Calendar ${i + 1}`; } })();
    return { id: `ics:${i + 1}`, name, url };
  });
}

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescape(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** Parse an ICS date/datetime. Floating and TZID times are read as local time. */
export function parseIcsDate(value, params = {}) {
  const v = value.trim();
  const d = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d || params.VALUE === 'DATE') {
    const [, y, mo, da] = d || v.match(/^(\d{4})(\d{2})(\d{2})/);
    return { date: new Date(Number(y), Number(mo) - 1, Number(da)), allDay: true };
  }
  const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!t) return null;
  const [, y, mo, da, h, mi, s, z] = t;
  const args = [Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s)];
  return { date: z ? new Date(Date.UTC(...args)) : new Date(...args), allDay: false };
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...rawParams] = head.split(';');
  const params = Object.fromEntries(rawParams.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  return { name: name.toUpperCase(), params, value };
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'SUMMARY': cur.summary = unescape(p.value); break;
      case 'DESCRIPTION': cur.description = unescape(p.value); break;
      case 'LOCATION': cur.location = unescape(p.value); break;
      case 'UID': cur.uid = p.value; break;
      case 'STATUS': cur.status = p.value; break;
      case 'RRULE': cur.rrule = Object.fromEntries(p.value.split(';').map((x) => x.split('='))); break;
      case 'DTSTART': { const r = parseIcsDate(p.value, p.params); if (r) { cur.start = r.date; cur.allDay = r.allDay; } break; }
      case 'DTEND': { const r = parseIcsDate(p.value, p.params); if (r) cur.end = r.date; break; }
      case 'EXDATE':
        for (const v of p.value.split(',')) { const r = parseIcsDate(v, p.params); if (r) cur.exdates.push(r.date.getTime()); }
        break;
      default:
    }
  }
  return events;
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Expand events (including recurrences) that overlap [from, to). */
export function expand(events, from, to, cap = 500) {
  const out = [];
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    const dur = (ev.end ? ev.end - ev.start : ev.allDay ? 86_400_000 : 0);
    const push = (start) => {
      if (ev.exdates.includes(start.getTime())) return;
      const end = new Date(start.getTime() + dur);
      if (end > from && start < to) out.push({ ...ev, start, end, exdates: undefined, rrule: undefined });
    };
    if (!ev.rrule) { push(ev.start); continue; }
    const r = ev.rrule;
    const interval = Number(r.INTERVAL || 1);
    const until = r.UNTIL ? parseIcsDate(r.UNTIL)?.date : null;
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    const byday = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]).filter((d) => d !== undefined) : null;
    let n = 0;
    let i = 0;
    const step = (k) => {
      const d = new Date(ev.start);
      if (r.FREQ === 'DAILY') d.setDate(d.getDate() + k * interval);
      else if (r.FREQ === 'WEEKLY') d.setDate(d.getDate() + k * 7 * interval);
      else if (r.FREQ === 'MONTHLY') d.setMonth(d.getMonth() + k * interval);
      else if (r.FREQ === 'YEARLY') d.setFullYear(d.getFullYear() + k * interval);
      else return null;
      return d;
    };
    for (; n < count && i < 5000; i++) {
      const base = step(i);
      if (!base || base >= to || (until && base > until)) break;
      let candidates = [base];
      if (r.FREQ === 'WEEKLY' && byday) {
        const weekStart = new Date(base);
        weekStart.setDate(base.getDate() - base.getDay());
        candidates = byday.sort().map((day) => {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + day);
          return d;
        }).filter((d) => d >= ev.start);
      }
      for (const c of candidates) {
        if (n >= count || (until && c > until)) break;
        n++;
        push(c);
      }
      if (out.length >= cap) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const cache = new Map(); // url -> { at, events }

export async function loadFeed(feed, fetchImpl = fetch) {
  const hit = cache.get(feed.url);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.events;
  const res = await fetchImpl(feed.url, { headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`Could not load ${feed.name} (${res.status})`);
  const events = parseIcs(await res.text());
  cache.set(feed.url, { at: Date.now(), events });
  return events;
}
