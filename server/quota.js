import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, resolveApiKey } from './settings.js';

/**
 * Usage limits per provider. Two kinds of signal:
 *  - real limits the provider reports: Claude Code's rate_limit_event
 *    (utilization of the current window, reset time), and 429 responses;
 *  - an optional token budget per rolling window from Settings, for API keys.
 *
 * Automatic work (sending the queue) stops at (100 - reserve)% so the last
 * slice of quota stays available for new instructions from the user.
 */
const FILE = () => path.join(DATA_DIR, 'quota.json');
const LABEL = { anthropic: 'Claude API', gemini: 'Gemini', claudeCode: 'Claude Code' };

let state = null; // { providers: { [p]: { utilization, status, resetsAt, updatedAt } }, log: [{ ts, provider, tokens }] }

async function load() {
  if (state) return state;
  try { state = JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch { state = { providers: {}, log: [] }; }
  state.providers ||= {};
  state.log ||= [];
  return state;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
      await fs.writeFile(FILE(), JSON.stringify(state), { mode: 0o600 });
    } catch { /* best effort */ }
  }, 200);
  saveTimer.unref?.();
}

/** A limit signal from a provider. resetsAt is in ms. */
export async function update(provider, { utilization, status, resetsAt }) {
  const s = await load();
  const p = (s.providers[provider] ||= {});
  if (typeof utilization === 'number') p.utilization = utilization;
  if (status) p.status = status;
  if (resetsAt) p.resetsAt = resetsAt;
  if (status === 'rejected' && typeof utilization !== 'number') p.utilization = 1;
  p.updatedAt = Date.now();
  save();
  return p;
}

/** Count tokens used, for providers with a configured budget. */
export async function record(provider, usage) {
  const tokens = (usage?.input || 0) + (usage?.output || 0);
  if (!tokens) return;
  const s = await load();
  s.log.push({ ts: Date.now(), provider, tokens });
  const cutoff = Date.now() - 7 * 86_400_000;
  s.log = s.log.filter((e) => e.ts > cutoff);
  save();
}

function budgetUse(s, provider, cfg) {
  if (!cfg?.budget) return null;
  const windowMs = (cfg.windowHours || 5) * 3_600_000;
  const since = Date.now() - windowMs;
  const entries = s.log.filter((e) => e.provider === provider && e.ts > since);
  const used = entries.reduce((n, e) => n + e.tokens, 0);
  const oldest = entries[0]?.ts;
  return { utilization: used / cfg.budget, used, budget: cfg.budget, resetsAt: oldest ? oldest + windowMs : null };
}

/** Current view of a provider's quota. */
export async function status(settings, provider) {
  const s = await load();
  const reserve = (settings.quota?.reservePercent ?? 5) / 100;
  const p = { ...(s.providers[provider] || {}) };
  // A reported limit that has already reset no longer applies.
  if (p.resetsAt && p.resetsAt < Date.now()) { p.status = 'allowed'; p.utilization = 0; p.resetsAt = null; }
  const b = budgetUse(s, provider, settings.quota?.[provider]);
  let utilization = p.utilization ?? null;
  let resetsAt = p.resetsAt ?? null;
  let source = utilization != null ? 'provider' : null;
  if (b && (utilization == null || b.utilization > utilization)) {
    utilization = b.utilization; resetsAt = b.resetsAt; source = 'budget';
  }
  const exhausted = p.status === 'rejected' || (utilization != null && utilization >= 1);
  const inReserve = !exhausted && utilization != null && utilization >= 1 - reserve;
  const low = !exhausted && (p.status === 'allowed_warning' || (utilization != null && utilization >= 0.8));
  return { provider, label: LABEL[provider], utilization, resetsAt, source, exhausted, inReserve, low, reservePercent: reserve * 100, budget: b };
}

function connected(settings, provider) {
  if (provider === 'claudeCode') return Boolean(settings.claudeCode.binaryPath);
  return Boolean(resolveApiKey(settings, provider).key);
}

/** Other connected providers with room left, best first. */
export async function alternatives(settings, current) {
  const out = [];
  for (const p of ['claudeCode', 'anthropic', 'gemini']) {
    if (p === current || !connected(settings, p)) continue;
    const st = await status(settings, p);
    if (st.exhausted || st.inReserve) continue;
    out.push({ provider: p, label: LABEL[p], model: settings[p].model || '', utilization: st.utilization });
  }
  return out.sort((a, b) => (a.utilization ?? 0) - (b.utilization ?? 0));
}

/**
 * May work start now? kind = 'user' for a message the user just sent (may use
 * the reserve), 'auto' for queued or resumed work (may not).
 */
export async function check(settings, provider, kind = 'user') {
  const st = await status(settings, provider);
  if (st.exhausted) return { ok: false, reason: 'exhausted', ...st };
  if (kind === 'auto' && st.inReserve) return { ok: false, reason: 'reserve', ...st };
  return { ok: true, ...st };
}

/** Recognise a usage-limit failure in an error message. Returns resetsAt (ms) when it can tell. */
export function limitFromError(err) {
  if (err?.quota) return err.quota;
  const msg = String(err?.message || err || '');
  if (!/usage limit|rate limit|quota|429|RESOURCE_EXHAUSTED|limit reached|out of (credits|tokens)/i.test(msg)) return null;
  let resetsAt = null;
  const epoch = msg.match(/\|(\d{10})\b/) || msg.match(/resets?(?:At)?["=: ]+(\d{10})\b/i);
  if (epoch) resetsAt = Number(epoch[1]) * 1000;
  const secs = msg.match(/retry (?:after|in) (\d+(?:\.\d+)?)\s*s/i);
  if (!resetsAt && secs) resetsAt = Date.now() + Number(secs[1]) * 1000;
  return { status: 'rejected', resetsAt };
}

/** For tests. */
export function _reset() { state = { providers: {}, log: [] }; }
