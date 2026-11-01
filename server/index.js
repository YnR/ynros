import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, updateSettings, publicSettings, PROVIDERS } from './settings.js';
import * as store from './store.js';
import * as runs from './runs.js';
import { triage } from './triage.js';
import * as files from './files.js';
import * as projects from './projects.js';
import * as tools from './tools.js';
import * as google from './integrations/google.js';
import * as skillsLib from './integrations/skills.js';
import { local } from './local.js';
import crypto from 'node:crypto';
import * as anthropic from './providers/anthropic.js';
import * as gemini from './providers/gemini.js';
import * as claudeCode from './providers/claudeCode.js';

export const providers = { anthropic, gemini, claudeCode };

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new HttpError(413, 'Body too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

/**
 * This server holds API keys and can run Claude Code on your machine, so it
 * only answers requests addressed to localhost (blocks DNS rebinding) and
 * rejects cross-site writes.
 */
export function isAllowedRequest(req, port) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (!allowedHosts.has(new URL(origin).host)) return false;
    } catch { return false; }
  }
  return true;
}

function titleFrom(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New chat';
}

function getProvider(name) {
  const p = providers[name];
  if (!p) throw new HttpError(400, `Unknown provider "${name}"`);
  return p;
}

/** The folder a chat works in: its project, else the Claude Code working directory. */
async function rootFor(settings, projectId) {
  const project = await projects.getProject(settings, projectId);
  return project?.path || settings.claudeCode.workingDirectory || null;
}

/** Add a user turn to the conversation and start a run for it. */
async function beginTurn(conv, text, { provider: providerName, model, batch } = {}) {
  const settings = await loadSettings();
  providerName ||= conv.provider || settings.defaultProvider;
  const provider = getProvider(providerName);
  model ??= conv.model ?? '';

  // Claude Code holds its own history; if the user switched away and back,
  // start a fresh CLI session so the transcript doesn't silently diverge.
  if (providerName === 'claudeCode' && conv.provider !== 'claudeCode' && conv.messages.length) {
    conv.claudeCodeSessionId = null;
  }
  conv.provider = providerName;
  conv.model = model;
  if (!conv.messages.length) conv.title = titleFrom(text);
  const msg = { role: 'user', content: text, ts: new Date().toISOString() };
  if (batch) msg.batch = batch;
  // @mentions: API models get the file contents inline; Claude Code reads files itself.
  const root = await rootFor(settings, conv.projectId);
  if (root && text.includes('@')) {
    try {
      if (providerName === 'claudeCode') {
        const found = await files.resolveMentions(root, text);
        if (found.length) msg.attachments = found.map((f) => f.path);
      } else {
        const { content, attachments } = await files.expandMentions(root, text);
        if (attachments.length) { msg.attachments = attachments; msg.providerContent = content; }
      }
    } catch (e) { console.warn('mentions:', e.message); }
  }
  conv.messages.push(msg);
  await store.saveConversation(conv);

  return runs.startRun({
    conv, provider, providerName, model, settings,
    onFinish: (run) => drainQueue(conv, run),
  });
}

/** After a run ends, send everything that was queued as one batch. */
async function drainQueue(conv, run) {
  if (!conv.queue?.length) return;
  // A manual Stop pauses the queue; the user can send it with "Send now".
  if (run?.stopReason === 'user') {
    conv.queuePaused = true;
    await store.saveConversation(conv);
    runs.hub.emit('update', { type: 'queue', conversationId: conv.id, queue: conv.queue, paused: true });
    return;
  }
  const items = conv.queue;
  conv.queue = [];
  conv.queuePaused = false;
  const text = items.length === 1
    ? items[0].text
    : `While you were working I sent these additional instructions. Handle them together:\n\n${
      items.map((q, i) => `${i + 1}. ${q.text}`).join('\n\n')}`;
  await beginTurn(conv, text, { batch: items.length > 1 ? items.map((q) => q.text) : undefined });
}

function queueEvent(conv) {
  const ev = { type: 'queue', conversationId: conv.id, queue: conv.queue || [], paused: Boolean(conv.queuePaused) };
  runs.emitTo(conv.id, ev);
  runs.hub.emit('update', ev);
}

let queueSeq = 0;

async function handleChat(req, res, id) {
  const body = await readJson(req);
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Message is empty');
  const active = runs.getRun(id);
  const conv = active?.conv || await store.getConversation(id);
  if (!conv) throw new HttpError(404, 'Conversation not found');

  if (!active) {
    // A paused queue (after Stop) goes out together with the new message.
    const pending = conv.queue || [];
    conv.queue = [];
    conv.queuePaused = false;
    const all = [...pending.map((q) => q.text), text];
    const combined = all.length === 1 ? text
      : `Here are my instructions, including ones I sent while you were working. Handle them together:\n\n${
        all.map((t, i) => `${i + 1}. ${t}`).join('\n\n')}`;
    const run = await beginTurn(conv, combined, {
      provider: body.provider, model: body.model, batch: all.length > 1 ? all : undefined,
    });
    return sendJson(res, 202, { runId: run.id, conversation: { id: conv.id, title: conv.title } });
  }

  // The chat is busy: queue the message and ask a small model whether it
  // should interrupt. Only the user can approve an interrupt.
  const item = { id: `q-${Date.now()}-${++queueSeq}`, text, ts: new Date().toISOString(), triage: { status: 'pending' } };
  conv.queue ||= [];
  conv.queue.push(item);
  await store.saveConversation(conv);
  queueEvent(conv);
  sendJson(res, 202, { queued: true, item });

  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
  const progress = active.events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  const context = {
    task: lastUser?.content,
    progress,
    subagents: (conv.subagents || []).filter((s) => s.runId === active.id),
    queued: conv.queue.filter((q) => q.id !== item.id).map((q) => q.text),
    message: text,
  };
  let verdict;
  try {
    verdict = await triage({ settings: await loadSettings(), providers, context });
  } catch (e) {
    verdict = { decision: 'queue', reason: `Could not reach the triage model (${e.message}), so it is queued.`, model: null };
  }
  item.triage = { status: 'done', ...verdict };
  if (conv.queue.includes(item)) {
    await store.saveConversation(conv);
    queueEvent(conv);
  }
}

async function handleQueueAction(req, res, id, itemId, action) {
  const active = runs.getRun(id);
  const conv = active?.conv || await store.getConversation(id);
  if (!conv) throw new HttpError(404, 'Conversation not found');
  conv.queue ||= [];
  if (action === 'delete') {
    conv.queue = conv.queue.filter((q) => q.id !== itemId);
    await store.saveConversation(conv);
    queueEvent(conv);
    return sendJson(res, 200, { queue: conv.queue });
  }
  if (action === 'keep') {
    const item = conv.queue.find((q) => q.id === itemId);
    if (item?.triage) item.triage.dismissed = true;
    await store.saveConversation(conv);
    queueEvent(conv);
    return sendJson(res, 200, { queue: conv.queue });
  }
  if (action === 'send') {
    // "Interrupt now" on a running chat, or "Send now" on a paused queue.
    if (active) runs.stopRun(id, 'interrupt');
    else await drainQueue(conv, null);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

/** NDJSON stream of one conversation's current run: replay so far, then live. */
function handleStream(req, res, id) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const run = runs.getStreamableRun(id);
  if (!run) {
    res.end(`${JSON.stringify({ type: 'idle' })}\n`);
    return;
  }
  const unsubscribe = runs.subscribe(run, (ev) => {
    if (ev === null) res.end();
    else if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
  });
  res.on('close', unsubscribe);
}

/** Server-Sent Events: run and subagent status across all conversations. */
function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  write({ type: 'snapshot', runs: runs.activeSummary() });
  runs.hub.on('update', write);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => { clearInterval(ping); runs.hub.off('update', write); });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[0] !== 'api') return serveStatic(res, url.pathname);

  if (parts[1] === 'events' && parts.length === 2 && method === 'GET') return handleEvents(req, res);

  if (parts[1] === 'tools') {
    // Called by the local MCP bridge that Claude Code runs; requires its token.
    const token = String(req.headers['x-harness-token'] || '');
    const ok = token.length === local.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(local.token));
    if (!ok) throw new HttpError(401, 'Missing tool token');
    const settings = await loadSettings();
    if (parts.length === 2 && method === 'GET') {
      const { tools: list } = await tools.availableTools(settings, { forClaudeCode: url.searchParams.get('for') === 'claudeCode' });
      return sendJson(res, 200, { tools: list.map(({ name, description, schema }) => ({ name, description, schema })) });
    }
    if (parts.length === 3 && method === 'POST') {
      try {
        return sendJson(res, 200, { result: await tools.runTool(parts[2], await readJson(req), settings) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
  }

  if (parts[1] === 'integrations' && parts.length === 2 && method === 'GET') {
    const settings = await loadSettings();
    const { tools: list, skills } = await tools.availableTools(settings);
    return sendJson(res, 200, {
      google: { ...(await google.status()), redirectUri: google.redirectUri(serverPort) },
      icsFeeds: (await import('./integrations/ics.js')).parseFeeds(settings.calendars.icsFeeds).map(({ id, name }) => ({ id, name })),
      tools: list.map((t) => t.name),
      skills: skills.map(({ name, description }) => ({ name, description })),
      skillDirs: skillsLib.skillDirs(settings),
    });
  }

  if (parts[1] === 'google') {
    const settings = await loadSettings();
    if (parts[2] === 'auth' && method === 'GET') {
      res.writeHead(302, { location: google.buildAuthUrl(settings, serverPort) });
      return res.end();
    }
    if (parts[2] === 'callback' && method === 'GET') {
      try {
        await google.handleCallback(settings, Object.fromEntries(url.searchParams));
        res.writeHead(302, { location: '/#/settings?google=connected' });
      } catch (e) {
        res.writeHead(302, { location: `/#/settings?google_error=${encodeURIComponent(e.message)}` });
      }
      return res.end();
    }
    if (parts[2] === 'disconnect' && method === 'POST') {
      await readJson(req);
      await google.disconnect();
      return sendJson(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'projects') {
    const settings = await loadSettings();
    if (parts.length === 2 && method === 'GET') {
      return sendJson(res, 200, {
        hostFolder: settings.projects.hostFolder || projects.defaultHostFolder(),
        lastProjectId: settings.projects.lastProjectId || null,
        projects: await projects.listProjects(settings),
      });
    }
    if (parts.length === 2 && method === 'POST') {
      const project = await projects.createProject(settings, await readJson(req));
      await updateSettings({ projects: { lastProjectId: project.id } });
      return sendJson(res, 201, project);
    }
    if (parts.length === 3 && method === 'DELETE') {
      await projects.removeProject(parts[2]);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'mentions' && parts.length === 2 && method === 'GET') {
    const settings = await loadSettings();
    let pid = url.searchParams.get('project');
    const cid = url.searchParams.get('conversation');
    if (!pid && cid) pid = (await store.getConversation(cid))?.projectId;
    const root = await rootFor(settings, pid);
    if (!root) return sendJson(res, 200, { root: null, files: [] });
    return sendJson(res, 200, await files.listAllFiles(root, { query: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit')) || 50 }));
  }

  if (parts[1] === 'files') {
    const settings = await loadSettings();
    const pid = url.searchParams.get('project');
    const project = pid ? await projects.getProject(settings, pid) : null;
    const root = project?.path || settings.files.root || settings.claudeCode.workingDirectory;
    const rel = url.searchParams.get('path') || '';
    if (parts.length === 2 && method === 'GET') return sendJson(res, 200, await files.listFiles(root));
    if (parts[2] === 'content' && method === 'GET') return sendJson(res, 200, await files.readFile(root, rel));
    if (parts[2] === 'content' && method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, await files.writeFile(root, body.path, body.content, body.expectedMtime));
    }
  }

  if (parts[1] === 'settings' && parts.length === 2) {
    if (method === 'GET') return sendJson(res, 200, publicSettings(await loadSettings()));
    if (method === 'PUT') return sendJson(res, 200, publicSettings(await updateSettings(await readJson(req))));
  }

  if (parts[1] === 'models' && parts.length === 3 && method === 'GET') {
    const provider = getProvider(parts[2]);
    const settings = await loadSettings();
    try {
      return sendJson(res, 200, { models: await provider.listModels(settings), live: true });
    } catch (e) {
      const models = provider.FALLBACK_MODELS.map((id) => ({ id, label: id || 'default' }));
      return sendJson(res, 200, { models, live: false, error: e.message });
    }
  }

  if (parts[1] === 'test' && parts.length === 3 && method === 'POST') {
    const provider = getProvider(parts[2]);
    try {
      return sendJson(res, 200, await provider.test(await loadSettings()));
    } catch (e) {
      return sendJson(res, 200, { ok: false, message: e.message });
    }
  }

  if (parts[1] === 'conversations') {
    const id = parts[2];
    if (!id) {
      if (method === 'GET') {
        const active = new Map(runs.activeSummary().map((r) => [r.conversationId, r]));
        const list = (await store.listConversations()).map((c) => {
          const r = active.get(c.id);
          return r ? { ...c, running: true, subagentsRunning: r.subagents.filter((s) => s.status === 'running').length } : c;
        });
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const settings = await loadSettings();
        const provider = PROVIDERS.includes(body.provider) ? body.provider : settings.defaultProvider;
        const model = body.model ?? settings[provider]?.model ?? '';
        const project = body.projectId ? await projects.getProject(settings, body.projectId) : null;
        if (project) await updateSettings({ projects: { lastProjectId: project.id } });
        return sendJson(res, 201, await store.createConversation({ provider, model, projectId: project?.id || null }));
      }
    } else if (parts.length === 3) {
      if (method === 'GET') {
        const c = runs.getRun(id)?.conv || await store.getConversation(id);
        if (!c) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, 200, { ...c, running: Boolean(runs.getRun(id)) });
      }
      if (method === 'PATCH') {
        const c = runs.getRun(id)?.conv || await store.getConversation(id);
        if (!c) throw new HttpError(404, 'Not found');
        const body = await readJson(req);
        if (typeof body.title === 'string' && body.title.trim()) c.title = body.title.trim().slice(0, 200);
        if (PROVIDERS.includes(body.provider)) c.provider = body.provider;
        if (typeof body.model === 'string') c.model = body.model;
        return sendJson(res, 200, await store.saveConversation(c));
      }
      if (method === 'DELETE') {
        runs.stopRun(id);
        await runs.waitForIdle(id);
        await store.deleteConversation(id);
        return sendJson(res, 200, { ok: true });
      }
    } else if (parts[3] === 'messages' && parts.length === 4 && method === 'POST') {
      return handleChat(req, res, id);
    } else if (parts[3] === 'stream' && parts.length === 4 && method === 'GET') {
      return handleStream(req, res, id);
    } else if (parts[3] === 'stop' && parts.length === 4 && method === 'POST') {
      return sendJson(res, 200, { stopped: runs.stopRun(id, 'user') });
    } else if (parts[3] === 'queue' && parts.length === 6 && method === 'POST') {
      return handleQueueAction(req, res, id, parts[4], parts[5]);
    } else if (parts[3] === 'queue' && parts.length === 5 && method === 'DELETE') {
      return handleQueueAction(req, res, id, parts[4], 'delete');
    }
  }

  throw new HttpError(404, 'Not found');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

let serverPort = 4317;

export function createServer({ port }) {
  serverPort = port;
  local.url = `http://127.0.0.1:${port}`;
  return http.createServer(async (req, res) => {
    if (!isAllowedRequest(req, port)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden: this harness only accepts requests to localhost.');
    }
    try {
      await route(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: e.message });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4317;
  const host = process.env.HOST || '127.0.0.1';
  createServer({ port }).listen(port, host, () => {
    console.log(`Harness running at http://localhost:${port}`);
  });
}
