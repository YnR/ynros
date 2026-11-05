import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, loadSettings } from './settings.js';
import * as ha from './integrations/homeassistant.js';
import { hub } from './runs.js';

/**
 * Automations: "when <time and/or place>, do <notify | run a prompt>".
 *
 * Triggers
 *   schedule: { time: "08:30", days: [1,2,3,4,5] }   (days 0=Sun…6=Sat; omit for every day)
 *   at:       "2026-11-03T17:00:00"                   (one-off reminder)
 *   zone:     { zone: "Work", event: "enter" | "leave" | "in" | "not_in" }
 * With schedule/at plus zone, the zone is a condition checked at that time.
 * With only a zone, enter/leave fire on the transition (location from Home Assistant).
 *
 * Actions
 *   notify: { title, message } → phone (Home Assistant) and this app
 *   prompt: { prompt, provider?, projectId? } → starts a chat, then notifies you with the result
 */
const FILE = () => path.join(DATA_DIR, 'automations.json');
let rules = null;
let lastZone = null;
let lastPoll = 0;
let timer = null;
let startChat = null; // injected: async ({ prompt, provider, projectId, title }) => conversationId
const watching = new Map(); // conversationId -> rule

async function load() {
  if (rules) return rules;
  try {
    const j = JSON.parse(await fs.readFile(FILE(), 'utf8'));
    rules = j.rules || [];
    lastZone = j.lastZone ?? null;
  } catch { rules = []; }
  return rules;
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE(), JSON.stringify({ rules, lastZone }, null, 2), { mode: 0o600 });
}

export async function list() { return load(); }

function validate(rule) {
  const t = rule.trigger || {};
  if (!t.schedule && !t.at && !t.zone) throw Object.assign(new Error('An automation needs a schedule, a time, or a zone'), { status: 400 });
  if (t.schedule && !/^\d{1,2}:\d{2}$/.test(t.schedule.time || '')) throw Object.assign(new Error('Schedule time must look like 08:30'), { status: 400 });
  if (t.at && Number.isNaN(new Date(t.at).getTime())) throw Object.assign(new Error('Bad date for "at"'), { status: 400 });
  if (t.zone && !t.zone.zone) throw Object.assign(new Error('Name the zone (e.g. home, Work)'), { status: 400 });
  const a = rule.action || {};
  if (a.type !== 'notify' && a.type !== 'prompt') throw Object.assign(new Error('Action must be notify or prompt'), { status: 400 });
  if (a.type === 'prompt' && !a.prompt) throw Object.assign(new Error('A prompt action needs a prompt'), { status: 400 });
  if (a.type === 'notify' && !a.title && !a.message) throw Object.assign(new Error('A notification needs a title or message'), { status: 400 });
}

export async function create(rule) {
  validate(rule);
  await load();
  const r = {
    id: crypto.randomUUID(),
    name: rule.name || describe(rule),
    enabled: rule.enabled !== false,
    trigger: rule.trigger,
    action: rule.action,
    createdAt: new Date().toISOString(),
    lastFired: null,
  };
  rules.push(r);
  await save();
  return r;
}

export async function remove(id) {
  await load();
  rules = rules.filter((r) => r.id !== id);
  await save();
}

export async function setEnabled(id, enabled) {
  await load();
  const r = rules.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('No such automation'), { status: 404 });
  r.enabled = Boolean(enabled);
  await save();
  return r;
}

export function describe(rule) {
  const t = rule.trigger || {};
  const parts = [];
  if (t.at) parts.push(`at ${new Date(t.at).toLocaleString()}`);
  if (t.schedule) {
    const days = t.schedule.days?.length ? ` on ${t.schedule.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}` : ' every day';
    parts.push(`at ${t.schedule.time}${days}`);
  }
  if (t.zone) {
    const verb = { enter: 'when I arrive at', leave: 'when I leave', in: 'if I am at', not_in: 'if I am not at' }[t.zone.event || 'enter'];
    parts.push(`${verb} ${t.zone.zone}`);
  }
  const a = rule.action || {};
  const what = a.type === 'prompt' ? `run "${String(a.prompt).slice(0, 60)}"` : `notify "${a.title || a.message}"`;
  return `${what} ${parts.join(' ')}`.trim();
}

/* ---------- engine ---------- */

function sameMinute(a, b) { return a && b && Math.floor(a / 60000) === Math.floor(b / 60000); }

/** Is a scheduled rule due at `now`? */
export function scheduleDue(rule, now = new Date()) {
  const t = rule.trigger;
  const last = rule.lastFired ? new Date(rule.lastFired).getTime() : 0;
  if (t.at) {
    const at = new Date(t.at).getTime();
    return now.getTime() >= at && last < at && now.getTime() - at < 6 * 3_600_000;
  }
  if (t.schedule) {
    const [h, m] = t.schedule.time.split(':').map(Number);
    if (t.schedule.days?.length && !t.schedule.days.includes(now.getDay())) return false;
    const due = new Date(now); due.setHours(h, m, 0, 0);
    // Fire within 10 minutes after the time (covers sleep/restarts), once per day.
    return now >= due && now - due < 10 * 60_000 && !(last >= due.getTime());
  }
  return false;
}

async function currentZone(settings, force = false) {
  if (!ha.connected(settings) || !settings.homeAssistant.locationEntity) return null;
  if (!force && Date.now() - lastPoll < 55_000) return lastZone;
  lastPoll = Date.now();
  try {
    const loc = await ha.location(settings);
    return loc.zone;
  } catch { return lastZone; }
}

async function fire(rule, settings, reason) {
  rule.lastFired = new Date().toISOString();
  if (rule.trigger.at) rule.enabled = false; // one-off
  await save();
  const a = rule.action;
  hub.emit('update', { type: 'automation', id: rule.id, name: rule.name, reason, status: 'fired' });
  if (a.type === 'notify') {
    await deliver(settings, { title: a.title || rule.name, message: a.message || '' });
  } else if (a.type === 'prompt' && startChat) {
    const id = await startChat({ prompt: a.prompt, provider: a.provider, projectId: a.projectId, title: rule.name });
    watching.set(id, rule);
  }
}

/** Notify on every channel the user has: the phone (via Home Assistant) and this app. */
export async function deliver(settings, { title, message, conversationId }) {
  hub.emit('update', { type: 'automation', status: 'notify', title, message, conversationId });
  if (ha.connected(settings) && settings.homeAssistant.notifyService) {
    try { await ha.notifyPhone(settings, { title, message: message || title }); } catch (e) { console.warn('phone notify failed:', e.message); }
  }
}

export async function tick(now = new Date()) {
  const settings = await loadSettings();
  await load();
  const active = rules.filter((r) => r.enabled !== false);
  if (!active.length) return;
  const needZone = active.some((r) => r.trigger.zone);
  const prev = lastZone;
  const zone = needZone ? await currentZone(settings) : null;
  if (zone != null && zone !== lastZone) { lastZone = zone; await save(); }

  for (const r of active) {
    const t = r.trigger;
    try {
      if (t.schedule || t.at) {
        if (!scheduleDue(r, now)) continue;
        if (t.zone) {
          const z = await currentZone(settings, true);
          if (z == null) continue;
          const isIn = ha.inZone(z, t.zone.zone);
          const want = t.zone.event === 'not_in' || t.zone.event === 'leave' ? !isIn : isIn;
          if (!want) { r.lastFired = now.toISOString(); await save(); continue; } // skip today
        }
        await fire(r, settings, 'schedule');
      } else if (t.zone && prev != null && zone != null && prev !== zone) {
        const wasIn = ha.inZone(prev, t.zone.zone);
        const isIn = ha.inZone(zone, t.zone.zone);
        const ev = t.zone.event || 'enter';
        if ((ev === 'enter' && !wasIn && isIn) || (ev === 'leave' && wasIn && !isIn)) {
          if (!sameMinute(new Date(r.lastFired || 0).getTime(), now.getTime())) await fire(r, settings, `zone ${ev}`);
        }
      }
    } catch (e) {
      console.warn(`automation ${r.name} failed:`, e.message);
    }
  }
}

export function start({ startConversation }) {
  startChat = startConversation;
  // Tell the user when a prompt automation's chat finishes.
  hub.on('update', async (ev) => {
    if (ev.type !== 'run' || ev.status === 'running' || !watching.has(ev.conversationId)) return;
    const rule = watching.get(ev.conversationId);
    watching.delete(ev.conversationId);
    await deliver(await loadSettings(), {
      title: rule.name, message: ev.preview || (ev.status === 'error' ? 'The automation ran into a problem.' : 'Done.'), conversationId: ev.conversationId,
    });
  });
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 30_000);
  timer.unref?.();
  tick().catch(() => {});
}

/** For tests. */
export function _reset() { rules = []; lastZone = null; lastPoll = 0; }
export function _setZone(z) { lastZone = z; lastPoll = Date.now(); }
