// News tab: feed and news-topic items as cards, with read state that survives restarts.
// The first time news is loaded, everything already published counts as read;
// later arrivals are unread (they glow in the UI) until marked read.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './settings.js';
import { parseSources, loadSource } from './integrations/feeds.js';

const STATE = () => path.join(DATA_DIR, 'news-state.json');
const idFor = (item) => crypto.createHash('sha1').update(item.link || `${item.title}|${item.date}`).digest('hex').slice(0, 16);

async function readState() {
  try { return JSON.parse(await fs.readFile(STATE(), 'utf8')); } catch { return { baseline: null, read: {}, unread: {} }; }
}
async function writeState(s) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  // Keep the newest 2000 read marks.
  const keep = (o) => Object.fromEntries(Object.entries(o || {}).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 2000));
  await fs.writeFile(STATE(), JSON.stringify({ ...s, read: keep(s.read), unread: keep(s.unread) }), { mode: 0o600 });
}

let lastUnread = 0;

export async function list(settings, { perSource = 30 } = {}) {
  const state = await readState();
  const firstRun = !state.baseline;
  const items = [];
  const errors = [];
  await Promise.all(parseSources(settings).map(async (src) => {
    try {
      const { items: got } = await loadSource(src);
      for (const it of got.slice(0, perSource)) {
        items.push({ ...it, id: idFor(it), source: it.source || src.name, sourceKind: src.kind, feed: src.name });
      }
    } catch (e) { errors.push(e.message); }
  }));
  const now = new Date().toISOString();
  for (const it of items) {
    if (state.read[it.id] || state.unread[it.id]) continue;
    // Seen for the first time: before the baseline everything is read; afterwards it is new.
    if (firstRun) state.read[it.id] = now;
    else state.unread[it.id] = now;
  }
  if (firstRun) state.baseline = now;
  await writeState(state);
  for (const it of items) it.read = !state.unread[it.id];
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  lastUnread = items.filter((i) => !i.read).length;
  return { items, unread: lastUnread, ...(errors.length ? { errors } : {}) };
}

export async function markRead(ids, read = true) {
  const state = await readState();
  const now = new Date().toISOString();
  for (const id of ids) {
    if (read) { delete state.unread[id]; state.read[id] = now; } else { state.unread[id] = now; delete state.read[id]; }
  }
  await writeState(state);
  lastUnread = Object.keys(state.unread).length;
  return { unread: lastUnread };
}

export const unreadCount = () => lastUnread;
