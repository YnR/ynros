import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { availableTools, runTool, toolSystemNote } from './tools.js';
import { local } from './local.js';

const MCP_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');

/** Tools for this run: function tools for API models, an MCP bridge for Claude Code. */
async function toolOptions(settings, providerName) {
  const isCC = providerName === 'claudeCode';
  const { tools, skills } = await availableTools(settings, { forClaudeCode: isCC });
  if (!tools.length) return {};
  if (isCC) {
    if (!local.url) return {};
    return {
      mcpConfig: {
        mcpServers: {
          harness: { command: process.execPath, args: [MCP_SERVER], env: { HARNESS_URL: local.url, HARNESS_TOKEN: local.token } },
        },
      },
    };
  }
  return { tools, runTool: (name, args) => runTool(name, args, settings), systemNote: toolSystemNote(skills) };
}

/**
 * Runs execute on the server, independent of any browser tab. A tab can
 * subscribe to a conversation's run (getting a replay of everything so far),
 * and `hub` broadcasts run/subagent status for the sidebar and notifications.
 */
export const hub = new EventEmitter();
hub.setMaxListeners(0);

const runs = new Map(); // conversationId -> active run
const recent = new Map(); // conversationId -> last finished run, kept briefly for late subscribers

/** The active run, or one that just finished (so a tab that subscribes late still gets the replay). */
export function getStreamableRun(conversationId) {
  return runs.get(conversationId) || recent.get(conversationId) || null;
}

export function getRun(conversationId) {
  return runs.get(conversationId) || null;
}

/** Fold a subagent event into the conversation's subagent list. */
export function applySubagent(list, ev) {
  let sa = list.find((s) => s.id === ev.id);
  if (!sa) {
    sa = { id: ev.id, status: 'running', agentType: 'subagent', description: '', toolUses: 0, activity: '' };
    list.push(sa);
  }
  for (const k of ['status', 'agentType', 'description', 'background', 'startedAt', 'endedAt', 'result', 'activity', 'tokens']) {
    if (ev[k] !== undefined) sa[k] = ev[k];
  }
  if (typeof ev.toolUses === 'number') sa.toolUses = Math.max(sa.toolUses, ev.toolUses);
  else if (ev.toolUse) sa.toolUses += 1;
  return sa;
}

export function activeSummary() {
  return [...runs.values()].map(runSummary);
}

function runSummary(run) {
  const subs = run.conv.subagents || [];
  return {
    conversationId: run.conv.id,
    title: run.conv.title,
    status: run.status,
    startedAt: run.startedAt,
    subagents: subs.filter((s) => s.runId === run.id),
  };
}

let runSeq = 0;

export function startRun({ conv, provider, providerName, model, settings, onFinish }) {
  if (runs.has(conv.id)) throw Object.assign(new Error('This chat is already running.'), { status: 409 });

  const run = {
    id: `run-${Date.now()}-${++runSeq}`,
    conv,
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [],
    listeners: new Set(),
    controller: new AbortController(),
  };
  runs.set(conv.id, run);
  recent.delete(conv.id);
  conv.subagents ||= [];

  const emit = (ev) => {
    run.events.push(ev);
    for (const fn of run.listeners) fn(ev);
  };
  const broadcast = (extra = {}) => hub.emit('update', { type: 'run', ...runSummary(run), ...extra });

  emit({ type: 'start', runId: run.id, conversation: { id: conv.id, title: conv.title, provider: providerName, model } });
  broadcast();

  const assistant = { role: 'assistant', content: '', provider: providerName, model, ts: null, events: [] };
  let lastSave = 0;

  (async () => {
    try {
      let extra = {};
      try { extra = await toolOptions(settings, providerName); } catch (e) { console.warn('tools unavailable:', e.message); }
      for await (const ev of provider.stream({
        settings, messages: conv.messages, model, signal: run.controller.signal, conversation: conv, ...extra,
      })) {
        if (ev.type === 'text') assistant.content += ev.text;
        else if (ev.type === 'tool' || ev.type === 'tool_result') assistant.events.push(ev);
        else if (ev.type === 'skill') {
          const existing = assistant.events.find((x) => x.type === 'skill' && x.id === ev.id);
          if (existing) Object.assign(existing, ev);
          else assistant.events.push({ ...ev });
        }
        else if (ev.type === 'error') assistant.error = ev.message;
        else if (ev.type === 'subagent') {
          const sa = applySubagent(conv.subagents, ev);
          sa.runId = run.id;
          emit({ type: 'subagent', subagent: { ...sa } });
          broadcast();
          // Persist subagent progress now and then so a reload sees it.
          if (Date.now() - lastSave > 2000) { lastSave = Date.now(); store.saveConversation(conv).catch(() => {}); }
          continue;
        } else if (ev.type === 'meta') {
          if (ev.sessionId) conv.claudeCodeSessionId = ev.sessionId;
          if (ev.usage) assistant.usage = ev.usage;
          if (ev.costUsd != null) assistant.costUsd = ev.costUsd;
          if (ev.model && !assistant.model) assistant.model = ev.model;
        }
        emit(ev);
      }
    } catch (e) {
      if (!run.controller.signal.aborted) {
        assistant.error = e.message;
        emit({ type: 'error', message: e.message });
      }
    }
    if (run.controller.signal.aborted) assistant.stopped = true;
    for (const sa of conv.subagents) {
      if (sa.runId === run.id && sa.status === 'running') {
        sa.status = 'stopped';
        sa.endedAt = new Date().toISOString();
        emit({ type: 'subagent', subagent: { ...sa } });
      }
    }
    assistant.ts = new Date().toISOString();
    if (!assistant.events.length) delete assistant.events;
    conv.messages.push(assistant);
    try { await store.saveConversation(conv); } catch (e) { console.error('save failed', e); }

    run.status = assistant.stopped ? 'stopped' : assistant.error ? 'error' : 'done';
    emit({ type: 'done', message: assistant });
    runs.delete(conv.id);
    recent.set(conv.id, run);
    setTimeout(() => { if (recent.get(conv.id) === run) recent.delete(conv.id); }, 30_000).unref?.();
    broadcast({
      preview: (assistant.error || assistant.content).replace(/\s+/g, ' ').trim().slice(0, 160),
    });
    for (const fn of run.listeners) fn(null);
    run.listeners.clear();
    try { await onFinish?.(run); } catch (e) { console.error('onFinish failed', e); }
  })();

  return run;
}

/** Subscribe to a run: replays past events, then streams new ones. `null` marks the end. */
export function subscribe(run, fn) {
  for (const ev of run.events) fn(ev);
  if (run.status !== 'running') { fn(null); return () => {}; }
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

/** Push an extra event into a running conversation's stream (e.g. queue changes). */
export function emitTo(conversationId, ev) {
  const run = runs.get(conversationId);
  if (!run) return false;
  run.events.push(ev);
  for (const fn of run.listeners) fn(ev);
  return true;
}

/** reason: 'user' (Stop button) or 'interrupt' (to handle queued messages now). */
export function stopRun(conversationId, reason = 'user') {
  const run = runs.get(conversationId);
  if (!run) return false;
  run.stopReason = reason;
  run.controller.abort();
  return true;
}

/** For tests and shutdown. */
export function waitForIdle(conversationId) {
  const list = conversationId ? [runs.get(conversationId)].filter(Boolean) : [...runs.values()];
  return Promise.all(list.map((r) => new Promise((res) => {
    if (r.status !== 'running') res();
    else r.listeners.add((ev) => { if (ev === null) res(); });
  })));
}
