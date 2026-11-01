import crypto from 'node:crypto';
import * as runs from './runs.js';

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
    .map(([id, p]) => ({ id, tool: p.tool, summary: p.summary, at: p.at }));
}

/** Resolves to true (allow) or false (deny). */
export function request(conversationId, tool, input) {
  const id = crypto.randomUUID();
  const summary = summarize(tool, input);
  return new Promise((resolve) => {
    const timer = setTimeout(() => answer(id, false, 'timed out'), TIMEOUT);
    timer.unref?.();
    pending.set(id, { resolve, conversationId, tool, summary, input, at: new Date().toISOString(), timer });
    const ev = { type: 'approval', id, conversationId, tool, summary, status: 'pending' };
    runs.emitTo(conversationId, ev);
    runs.hub.emit('update', ev);
  });
}

export function answer(id, allow, note = '') {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
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
