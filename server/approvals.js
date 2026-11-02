import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as runs from './runs.js';
import { DATA_DIR } from './settings.js';
import * as store from './store.js';

/*
 * Always-allow rules, per project ('*' for chats outside a project), in Claude Code's
 * rule syntax: "Bash(git status:*)" for a command prefix, or a bare tool name.
 * Every ask is logged so Settings can suggest rules for read-only ones.
 */
const RULES = () => path.join(DATA_DIR, 'permissions.json');
const LOG = () => path.join(DATA_DIR, 'permission-log.jsonl');

export async function readRules() { try { return JSON.parse(await fs.readFile(RULES(), 'utf8')); } catch { return {}; } }
async function writeRules(r) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(RULES(), JSON.stringify(r, null, 2), { mode: 0o600 });
}
export async function addRule(scope, rule) {
  const r = await readRules();
  r[scope || '*'] = [...new Set([...(r[scope || '*'] || []), rule])];
  await writeRules(r);
  return r;
}
export async function removeRule(scope, rule) {
  const r = await readRules();
  r[scope || '*'] = (r[scope || '*'] || []).filter((x) => x !== rule);
  if (!r[scope || '*'].length) delete r[scope || '*'];
  await writeRules(r);
  return r;
}

/** Splits a shell command into simple commands (&&, ||, ;, |) so each part is checked. */
const parts = (cmd) => String(cmd || '').split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);

/** The rule "always allow" creates: command and subcommand for Bash, else the tool. */
export function ruleFor(tool, input) {
  if (tool === 'Bash' && input?.command) {
    const words = parts(input.command)[0]?.split(/\s+/) || [];
    const prefix = words.slice(0, /^(git|npm|pnpm|yarn|npx|docker|kubectl|gh|cargo|go|make|python3?|node)$/.test(words[0]) ? 2 : 1).join(' ');
    return `Bash(${prefix}:*)`;
  }
  return tool;
}

function matches(rule, tool, input) {
  const m = rule.match(/^(\w+)\((.*)\)$/);
  if (!m) return rule === tool;
  if (m[1] !== tool) return false;
  const pat = m[2];
  if (tool === 'Bash') {
    // Every part of a compound command must match, so "git status && rm -rf x" is not allowed by "git status".
    const prefix = pat.endsWith(':*') ? pat.slice(0, -2) : null;
    return parts(input?.command).every((c) => (prefix != null ? c === prefix || c.startsWith(`${prefix} `) : c === pat));
  }
  const target = input?.file_path || input?.url || input?.path || '';
  return pat.endsWith('*') ? target.startsWith(pat.slice(0, -1)) : target === pat;
}

/** Git commands that only read, or only change local state in ways git can undo. */
const SAFE_GIT = /^git\s+(status|diff|log|show|branch(\s+(-a|-r|--list|-v+|--show-current))*\s*$|fetch|add|commit|stash\s+(list|show)|remote(\s+-v)?\s*$|rev-parse|ls-files|blame|grep|describe|shortlog|tag\s*$|tag\s+-l|config\s+--get|worktree\s+list|switch\s+-c|checkout\s+-b)\b/;
export function isSafeGit(command) {
  const cmds = parts(command);
  return cmds.length > 0 && cmds.every((c) => SAFE_GIT.test(c) && !/\s--force\b|\s-f\b|--hard|--delete|\s-D\b/.test(c));
}

async function autoDecision(conversationId, tool, input, settings) {
  const conv = await store.getConversation(conversationId).catch(() => null);
  const scope = conv?.projectId || '*';
  const rules = await readRules();
  const rule = [...(rules[scope] || []), ...(scope !== '*' ? rules['*'] || [] : [])].find((r) => matches(r, tool, input));
  if (rule) return { allow: true, why: `always allowed (${rule})`, scope };
  if (tool === 'Bash' && settings?.permissions?.safeGit !== false && isSafeGit(input?.command)) {
    return { allow: true, why: 'safe git command', scope };
  }
  return { allow: null, scope };
}

async function logAsk(entry) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await fs.appendFile(LOG(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* logging is best effort */ }
}

/** Read-only asks from the last `days`, grouped into rule suggestions per project. */
export async function suggestions({ days = 14 } = {}) {
  let raw = '';
  try { raw = await fs.readFile(LOG(), 'utf8'); } catch { return []; }
  const since = Date.now() - days * 86_400_000;
  const rules = await readRules();
  const groups = new Map();
  for (const line of raw.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.ts || Date.parse(e.ts) < since || e.auto) continue;
    const rule = ruleFor(e.tool, e.input);
    if (!isReadOnlyRule(rule, e)) continue;
    if ((rules[e.scope] || []).includes(rule)) continue;
    const k = `${e.scope}\u0000${rule}`;
    const g = groups.get(k) || { scope: e.scope, rule, count: 0, allowed: 0, example: e.summary };
    g.count += 1;
    if (e.decision === 'allow') g.allowed += 1;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const READ_ONLY_BASH = /^Bash\((ls|cat|head|tail|wc|grep|rg|find|pwd|which|echo|stat|du|df|tree|file|sort|uniq|jq|date|whoami|env|printenv|git (status|diff|log|show|branch|remote|rev-parse|ls-files|blame|grep|describe|fetch)|npm (ls|view|outdated|test)|node --version|python3? --version)\b/;
function isReadOnlyRule(rule, e) {
  if (rule.startsWith('Bash(')) return READ_ONLY_BASH.test(rule);
  return /^(Read|Glob|Grep|LS|WebSearch|WebFetch|NotebookRead|TodoWrite)$/.test(rule) || looksReadOnly(String(e.tool).replace(/^mcp__[^_]+__/, ''));
}

/**
 * Ask the user before an action happens: Claude Code permission prompts (via
 * --permission-prompt-tool) and MCP tools marked "confirm" (e.g. a browser).
 * The run shows an Allow / Deny card; nothing proceeds until the user answers.
 */
const pending = new Map(); // id -> { resolve, conversationId, tool, summary, input, at }
const TIMEOUT = 15 * 60_000;

function summarize(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.url ?? input.file_path ?? input.text ?? input.selector ?? input.uid ?? input.query;
  const s = typeof v === 'string' ? v : JSON.stringify(input);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export function list(conversationId) {
  return [...pending.entries()].filter(([, p]) => p.conversationId === conversationId)
    .map(([id, p]) => ({ id, tool: p.tool, summary: p.summary, at: p.at, rule: ruleFor(p.tool, p.input) }));
}

/** Resolves to true (allow) or false (deny). Always-allow rules and safe git answer without asking. */
export async function request(conversationId, tool, input, settings) {
  const summary = summarize(tool, input);
  const auto = await autoDecision(conversationId, tool, input, settings);
  if (auto.allow) {
    logAsk({ ts: new Date().toISOString(), scope: auto.scope, tool, input: trimInput(input), summary, decision: 'allow', auto: auto.why });
    const ev = { type: 'approval', id: crypto.randomUUID(), conversationId, tool, summary, status: 'allowed', note: auto.why };
    runs.emitTo(conversationId, ev);
    return true;
  }
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => answer(id, false, 'timed out'), TIMEOUT);
    timer.unref?.();
    pending.set(id, { resolve, conversationId, tool, summary, input, scope: auto.scope, at: new Date().toISOString(), timer });
    const ev = { type: 'approval', id, conversationId, tool, summary, status: 'pending', rule: ruleFor(tool, input) };
    runs.emitTo(conversationId, ev);
    runs.hub.emit('update', ev);
  });
}

const trimInput = (input) => {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  return out;
};

/** `always`: also add an always-allow rule for this kind of call in the chat's project. */
export function answer(id, allow, note = '', { always = false } = {}) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  logAsk({ ts: new Date().toISOString(), scope: p.scope, tool: p.tool, input: trimInput(p.input), summary: p.summary, decision: allow ? 'allow' : 'deny', note });
  if (allow && always) {
    const rule = ruleFor(p.tool, p.input);
    addRule(p.scope, rule).catch(() => {});
    note = `always allowed from now on (${rule})`;
  }
  const ev = { type: 'approval', id, conversationId: p.conversationId, tool: p.tool, summary: p.summary, status: allow ? 'allowed' : 'denied', note };
  runs.emitTo(p.conversationId, ev);
  runs.hub.emit('update', ev);
  p.resolve(Boolean(allow));
  return true;
}

/** Deny everything still waiting for a conversation (e.g. when its run stops). */
export function cancelFor(conversationId) {
  for (const [id, p] of pending) if (p.conversationId === conversationId) answer(id, false, 'run ended');
}

/** Tools that only look, never act. Everything else on a "confirm" server needs approval. */
export function looksReadOnly(name) {
  return /^(list|get|read|search|find|query|take_screenshot|take_snapshot|screenshot|snapshot|wait|describe|fetch_?page|navigate_back)/i.test(name)
    || /(_list|_get|_read|_search|snapshot|screenshot)$/i.test(name);
}
