// Imports past chats into the harness:
//   - Claude Code transcripts   ~/.claude/projects/<folder>/<session>.jsonl
//   - Gemini CLI chats          ~/.gemini/tmp/<project hash>/chats/session-*.json (and /chat save checkpoints)
//   - claude.ai data export     conversations.json
//   - Gemini (Google Takeout)   My Activity/Gemini Apps/MyActivity.json
// Each chat goes into the project whose folder it ran in (or whose name it mentions),
// otherwise into the Misc group. Imports are idempotent: a chat keeps its id across
// re-imports and is only rewritten when its source has new messages.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as store from './store.js';
import { DATA_DIR } from './settings.js';
import { listProjects, registerFolder } from './projects.js';
import { summarizeArgs } from './toolLoop.js';

const sha = (s, n = 24) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const importId = (source, key) => `imp-${source}-${sha(`${source}:${key}`)}`;
const INDEX = () => path.join(DATA_DIR, 'history-index.json');
const SKILL_BODY = /^Base directory for this skill:/;
// The harness's own helper calls (triage and routing through Claude Code) are not chats.
const HELPER_PROMPT = /^(You triage messages a user sends|You route a user's message to the right model size)/;

const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const toIso = (t) => {
  if (t == null || t === '') return null;
  const d = new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const titleFrom = (text) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line ? (line.length > 60 ? `${line.slice(0, 57)}…` : line) : 'Imported chat';
};

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readIndex() { try { return JSON.parse(await fs.readFile(INDEX(), 'utf8')); } catch { return {}; } }
async function writeIndex(idx) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(INDEX(), JSON.stringify(idx), { mode: 0o600 });
}

/* ---------- Claude Code ---------- */

const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

/** Turns a command wrapper line into "/cmd args"; drops CLI-internal noise. */
function cleanUserText(text) {
  const t = text.trim();
  if (!t || t.startsWith('<local-command') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return '';
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return [cmd[1].trim(), args].filter(Boolean).join(' ');
  }
  return t;
}

/** Parses one Claude Code JSONL transcript. */
export function parseClaudeCodeTranscript(raw) {
  const out = { sessionId: null, cwd: null, title: null, messages: [], createdAt: null, updatedAt: null };
  const cwds = new Map();
  let customTitle = null;
  let aiTitle = null;
  let assistant = null; // merges the per-block lines of one assistant message
  let assistantId = null;
  const skillsWaiting = [];
  const flush = () => {
    if (assistant && (assistant.content.trim() || assistant.events.length)) {
      assistant.content = assistant.content.trim();
      out.messages.push(assistant);
    }
    assistant = null; assistantId = null;
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.sessionId) out.sessionId ||= o.sessionId;
    // Titles repeat through the file: the last one wins, and a name the user set beats the generated one.
    if (o.type === 'custom-title' && o.customTitle) { customTitle = o.customTitle; continue; }
    if (o.type === 'ai-title' && o.aiTitle) { aiTitle = o.aiTitle; continue; }
    if (o.type === 'summary' && o.summary) { aiTitle ||= o.summary; continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
    if (o.cwd) cwds.set(o.cwd, (cwds.get(o.cwd) || 0) + 1);
    const ts = toIso(o.timestamp);
    if (ts) { out.createdAt ||= ts; out.updatedAt = ts; }
    const msg = o.message || {};

    if (o.type === 'assistant') {
      const id = msg.id || o.uuid;
      if (assistantId !== id) {
        flush();
        assistant = { role: 'assistant', content: '', provider: 'claudeCode', model: msg.model || '', ts, events: [], imported: true };
        assistantId = id;
      }
      for (const b of blocks(msg.content)) {
        if (b.type === 'text' && b.text) assistant.content += (assistant.content ? '\n\n' : '') + b.text;
        else if (b.type === 'tool_use') {
          if (b.name === 'Skill') {
            const ev = { type: 'skill', id: b.id, name: b.input?.skill || 'skill', args: b.input?.args || '', text: null };
            skillsWaiting.push(ev);
            assistant.events.push(ev);
          } else {
            assistant.events.push({ type: 'tool', name: b.name, input: summarizeArgs(b.input) });
          }
        }
      }
      continue;
    }

    // user line: real prompts only (tool results and injected skill bodies are not turns)
    const parts = blocks(msg.content);
    const texts = parts.filter((b) => b.type === 'text' && b.text).map((b) => b.text);
    if (!texts.length) continue; // tool_result-only line
    const joined = texts.join('\n\n');
    if (SKILL_BODY.test(joined)) {
      const sk = skillsWaiting.shift();
      if (sk) sk.text = joined.replace(/^Base directory for this skill:[^\n]*\n?/, '').trim();
      continue;
    }
    const text = cleanUserText(joined);
    if (!text) continue;
    flush();
    out.messages.push({ role: 'user', content: text, ts, imported: true });
  }
  flush();
  out.title = customTitle || aiTitle;
  // A session can move between folders; use the one it spent most turns in.
  out.cwd = [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return out;
}

async function scanClaudeCode(dir) {
  const root = expand(dir) || path.join(os.homedir(), '.claude', 'projects');
  const found = [];
  let folders = [];
  try { folders = await fs.readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const f of folders) {
    if (!f.isDirectory()) continue;
    let files = [];
    try { files = await fs.readdir(path.join(root, f.name)); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, f.name, name);
      found.push({
        source: 'claudeCode',
        key: `${f.name}/${name.replace(/\.jsonl$/, '')}`,
        file,
        load: async () => {
          const t = parseClaudeCodeTranscript(await fs.readFile(file, 'utf8'));
          return {
            title: t.title, cwd: t.cwd, createdAt: t.createdAt, updatedAt: t.updatedAt,
            messages: t.messages, provider: 'claudeCode', claudeCodeSessionId: t.sessionId,
          };
        },
      });
    }
  }
  return found;
}

/* ---------- Gemini CLI ---------- */

const partsText = (content) => {
  if (typeof content === 'string') return content;
  const list = Array.isArray(content) ? content : content?.parts || [];
  return list.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n\n');
};

/** A Gemini CLI session file ({ messages: [{ type: user|gemini, content, toolCalls }] }). */
export function parseGeminiSession(data) {
  const messages = [];
  for (const m of data.messages || []) {
    const ts = toIso(m.timestamp);
    if (m.type === 'user') {
      const text = partsText(m.content).trim();
      if (text) messages.push({ role: 'user', content: text, ts, imported: true });
    } else if (m.type === 'gemini' || m.type === 'model') {
      const events = (m.toolCalls || []).map((c) => ({ type: 'tool', name: c.displayName || c.name, input: summarizeArgs(c.args) }));
      const text = partsText(m.content).trim();
      if (text || events.length) messages.push({ role: 'assistant', content: text, provider: 'gemini', model: m.model || '', ts, events, imported: true });
    }
  }
  return {
    messages,
    createdAt: toIso(data.startTime) || messages[0]?.ts || null,
    updatedAt: toIso(data.lastUpdated) || messages.at(-1)?.ts || null,
    projectHash: data.projectHash || null,
  };
}

/**
 * The JSONL session format: header lines { sessionId, projectHash, startTime, lastUpdated },
 * snapshot lines { $set: { messages, lastUpdated } } and single message lines. Messages
 * repeat across snapshots, so they are merged by id in first-seen order.
 */
export function parseGeminiSessionLines(raw) {
  const head = {};
  const byId = new Map();
  let n = 0;
  const put = (m) => { if (m && m.type) byId.set(m.id || `_${n++}`, m); };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.$set) {
      for (const m of o.$set.messages || []) put(m);
      if (o.$set.lastUpdated) head.lastUpdated = o.$set.lastUpdated;
    } else if (o.type && (o.content != null || o.toolCalls)) put(o);
    else {
      if (o.projectHash) head.projectHash ||= o.projectHash;
      if (o.startTime) head.startTime ||= o.startTime;
      if (o.lastUpdated) head.lastUpdated = o.lastUpdated;
      if (Array.isArray(o.messages)) o.messages.forEach(put);
    }
  }
  return parseGeminiSession({ ...head, messages: [...byId.values()] });
}

/** A /chat save checkpoint: an array of { role: user|model, parts }. */
export function parseGeminiCheckpoint(list) {
  const messages = [];
  for (const c of Array.isArray(list) ? list : []) {
    const text = partsText(c.parts).trim();
    if (!text) continue; // function calls/responses only
    messages.push(c.role === 'user'
      ? { role: 'user', content: text, ts: null, imported: true }
      : { role: 'assistant', content: text, provider: 'gemini', model: '', ts: null, events: [], imported: true });
  }
  return { messages };
}

async function scanGeminiCli(dir) {
  const root = expand(dir) || path.join(os.homedir(), '.gemini', 'tmp');
  const found = [];
  // ~/.gemini/projects.json maps project folders to the names of their tmp folders.
  const names = new Map();
  try {
    const pj = JSON.parse(await fs.readFile(path.join(path.dirname(root), 'projects.json'), 'utf8'));
    for (const [dir, name] of Object.entries(pj.projects || pj || {})) if (typeof name === 'string') names.set(name, dir);
  } catch { /* older CLI: hash-named folders */ }
  let folders = [];
  try { folders = await fs.readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const f of folders) {
    if (!f.isDirectory()) continue;
    const base = path.join(root, f.name);
    // Newer CLIs name the folder after the project and record its root.
    let projectRoot = names.get(f.name) || null;
    if (!projectRoot) try { projectRoot = (await fs.readFile(path.join(base, '.project_root'), 'utf8')).trim() || null; } catch { /* hash-named folder */ }
    const folderInfo = { folder: f.name, projectRoot };
    let chats = [];
    try { chats = await fs.readdir(path.join(base, 'chats')); } catch { /* none */ }
    for (const name of chats) {
      if (!/\.jsonl?$/.test(name)) continue;
      const file = path.join(base, 'chats', name);
      found.push({
        source: 'geminiCli', key: `${f.name}/${name}`, file,
        load: async () => {
          const raw = await fs.readFile(file, 'utf8');
          const s = name.endsWith('.jsonl') ? parseGeminiSessionLines(raw) : parseGeminiSession(JSON.parse(raw));
          return { ...s, ...folderInfo, projectHash: s.projectHash || f.name, provider: 'gemini' };
        },
      });
    }
    let top = [];
    try { top = await fs.readdir(base); } catch { /* none */ }
    for (const name of top) {
      if (!/^checkpoint-.+\.json$/.test(name)) continue;
      const file = path.join(base, name);
      found.push({
        source: 'geminiCli', key: `${f.name}/${name}`, file,
        load: async () => {
          const st = await fs.stat(file);
          const c = parseGeminiCheckpoint(JSON.parse(await fs.readFile(file, 'utf8')));
          const tag = name.replace(/^checkpoint-|\.json$/g, '');
          return { ...c, ...folderInfo, projectHash: f.name, title: `Saved chat: ${tag}`, createdAt: st.mtime.toISOString(), updatedAt: st.mtime.toISOString(), provider: 'gemini' };
        },
      });
    }
  }
  return found;
}

/* ---------- export files ---------- */

/** claude.ai export: [{ uuid, name, created_at, updated_at, chat_messages: [{ sender, text, content }] }]. */
export function parseClaudeExport(list) {
  return list.filter((c) => c && Array.isArray(c.chat_messages)).map((c) => {
    const messages = [];
    for (const m of c.chat_messages) {
      const text = (m.text || partsText(m.content) || '').trim();
      if (!text) continue;
      const ts = toIso(m.created_at);
      messages.push(m.sender === 'human'
        ? { role: 'user', content: text, ts, imported: true }
        : { role: 'assistant', content: text, provider: 'anthropic', model: '', ts, events: [], imported: true });
    }
    return {
      key: c.uuid || sha(JSON.stringify(c).slice(0, 2000)),
      title: c.name || null,
      createdAt: toIso(c.created_at) || messages[0]?.ts || null,
      updatedAt: toIso(c.updated_at) || messages.at(-1)?.ts || null,
      messages,
      provider: 'anthropic',
    };
  }).filter((c) => c.messages.length);
}

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const htmlToText = (html) => decodeEntities(String(html || '')
  .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();

/**
 * Google Takeout "Gemini Apps" activity has one entry per prompt and no chat ids,
 * so prompts less than 30 minutes apart are grouped into one chat.
 */
export function parseGeminiTakeout(list, { gapMinutes = 30 } = {}) {
  const entries = list
    .filter((e) => e && /gemini|bard/i.test(e.header || '') && typeof e.title === 'string')
    .map((e) => ({
      ts: toIso(e.time),
      prompt: e.title.replace(/^(Prompted|Asked)\s+/i, '').trim(),
      reply: (e.safeHtmlItem || []).map((x) => htmlToText(x.html)).filter(Boolean).join('\n\n'),
    }))
    .filter((e) => e.ts && e.prompt && !/^(Used|Gave feedback|Selected|Created|Updated)\b/.test(e.prompt))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const chats = [];
  let cur = null;
  for (const e of entries) {
    if (!cur || Date.parse(e.ts) - Date.parse(cur.updatedAt) > gapMinutes * 60_000) {
      cur = { key: e.ts, title: null, createdAt: e.ts, updatedAt: e.ts, messages: [], provider: 'gemini' };
      chats.push(cur);
    }
    cur.messages.push({ role: 'user', content: e.prompt, ts: e.ts, imported: true });
    if (e.reply) cur.messages.push({ role: 'assistant', content: e.reply, provider: 'gemini', model: '', ts: e.ts, events: [], imported: true });
    cur.updatedAt = e.ts;
  }
  return chats;
}

/** Recognizes an export file's format from its parsed JSON. */
export function parseExport(data) {
  const list = Array.isArray(data) ? data : data?.conversations || [];
  if (list.some((c) => Array.isArray(c?.chat_messages))) return { source: 'claudeExport', chats: parseClaudeExport(list) };
  if (list.some((e) => /gemini|bard/i.test(e?.header || ''))) return { source: 'geminiTakeout', chats: parseGeminiTakeout(list) };
  if (Array.isArray(data?.messages) && (data.sessionId || data.projectHash)) {
    return { source: 'geminiCli', chats: [{ key: data.sessionId || sha(JSON.stringify(data).slice(0, 2000)), ...parseGeminiSession(data), provider: 'gemini' }] };
  }
  return { source: null, chats: [] };
}

/* ---------- placing chats in projects ---------- */

function projectMatcher(projects) {
  const byPath = projects
    .map((p) => ({ p, root: path.resolve(p.path) }))
    .sort((a, b) => b.root.length - a.root.length);
  const hashes = new Map(projects.map((p) => [crypto.createHash('sha256').update(path.resolve(p.path)).digest('hex'), p]));
  const named = projects
    .filter((p) => p.name && p.name.length >= 3)
    .map((p) => ({ p, re: new RegExp(`(^|[^\\p{L}\\p{N}])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu') }));
  return (chat) => {
    const dir = chat.cwd || chat.projectRoot;
    if (dir) {
      const r = path.resolve(dir);
      const hit = byPath.find(({ root }) => r === root || r.startsWith(root + path.sep));
      if (hit) return { projectId: hit.p.id, how: 'folder' };
    }
    if (chat.projectHash && hashes.has(chat.projectHash)) return { projectId: hashes.get(chat.projectHash).id, how: 'folder' };
    if (chat.projectRoot == null && chat.cwd == null) {
      // No folder (web exports): look for a project's name in the title and first prompt.
      const text = `${chat.title || ''}\n${chat.messages.find((m) => m.role === 'user')?.content.slice(0, 500) || ''}`;
      const hits = named.filter(({ re }) => re.test(text));
      if (hits.length === 1) return { projectId: hits[0].p.id, how: 'name' };
    }
    return { projectId: null, how: 'misc' };
  };
}

/**
 * The project folder a chat ran in: the enclosing git repository (worktrees under
 * .claude/worktrees count as their repo), else a folder with its own CLAUDE.md or
 * GEMINI.md. Home and the filesystem root are never projects.
 */
export async function projectRootFor(dir) {
  if (!dir) return null;
  const home = os.homedir();
  let d = path.resolve(dir).replace(/[\\/]\.claude[\\/]worktrees([\\/].*)?$/, '');
  const never = (x) => x === home || x === path.parse(x).root;
  if (never(d)) return null;
  for (let cur = d; !never(cur); cur = path.dirname(cur)) {
    if (await exists(path.join(cur, '.git'))) return cur;
    if (path.dirname(cur) === cur) break;
  }
  for (const f of ['CLAUDE.md', 'GEMINI.md']) if (await exists(path.join(d, f))) return d;
  return null;
}

/* ---------- import ---------- */

async function saveImported(source, chat, match, { force } = {}) {
  const id = importId(source, chat.key);
  const existing = await store.getConversation(id);
  if (existing && !force && existing.messages.length >= chat.messages.length) return 'unchanged';
  const firstUser = chat.messages.find((m) => m.role === 'user');
  const conv = {
    id,
    title: (existing?.titleEdited && existing.title) || chat.title || titleFrom(firstUser?.content),
    provider: chat.provider,
    model: existing?.model ?? '',
    createdAt: existing?.createdAt || chat.createdAt || new Date().toISOString(),
    updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
    // Keep a project the user picked by hand; otherwise use the match.
    projectId: existing?.projectMoved ? existing.projectId : match.projectId,
    claudeCodeSessionId: chat.claudeCodeSessionId || existing?.claudeCodeSessionId || null,
    cwd: chat.cwd || null, // Claude Code resumes a session only from the folder it ran in
    imported: { source, key: chat.key, at: new Date().toISOString(), placedBy: match.how },
    // Turns added in the harness after an earlier import stay at the end.
    messages: [...chat.messages, ...(existing?.messages || []).filter((m) => !m.imported)],
  };
  await store.saveConversation(conv, { touch: false });
  return existing ? 'updated' : 'added';
}

function emptyReport() {
  return { added: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], byProject: {}, misc: 0, sources: {} };
}

function tally(report, source, result, match, projects) {
  report[result] += 1;
  report.sources[source] = (report.sources[source] || 0) + 1;
  if (result === 'unchanged') return;
  if (match.projectId) {
    const name = projects.find((p) => p.id === match.projectId)?.name || match.projectId;
    report.byProject[name] = (report.byProject[name] || 0) + 1;
  } else report.misc += 1;
}

let running = null;

/** Imports Claude Code and Gemini CLI history found on this computer. */
export function importLocal(settings, opts = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = settings.history || {};
    let projects = await listProjects(settings);
    let match = projectMatcher(projects);
    const idx = opts.force ? {} : await readIndex();
    const now = opts.now ?? Date.now();
    const ownSessions = new Set();
    for (const c of await store.listConversations()) {
      if (c.imported) continue;
      const full = await store.getConversation(c.id);
      if (full?.claudeCodeSessionId) ownSessions.add(full.claudeCodeSessionId);
    }
    const report = emptyReport();
    const want = opts.sources || ['claudeCode', 'geminiCli'];
    const found = [
      ...(want.includes('claudeCode') ? await scanClaudeCode(cfg.claudeCodeDir) : []),
      ...(want.includes('geminiCli') ? await scanGeminiCli(cfg.geminiDir) : []),
    ];
    for (const item of found) {
      try {
        const st = await fs.stat(item.file);
        const stamp = `${st.size}:${st.mtimeMs}`;
        if (idx[item.file] === stamp) { report.unchanged += 1; continue; }
        // A transcript written in the last 2 minutes is probably a session still running; take it next time.
        if (now - st.mtimeMs < 120_000) { report.active = (report.active || 0) + 1; continue; }
        const chat = { key: item.key, ...(await item.load()) };
        // Skip empty sessions, one-sided automated runs that never got a reply, the harness's
        // helper calls, and Claude Code sessions that already are harness chats.
        const first = chat.messages.find((m) => m.role === 'user');
        if (!first || !chat.messages.some((m) => m.role === 'assistant') || HELPER_PROMPT.test(first.content)
          || (chat.claudeCodeSessionId && ownSessions.has(chat.claudeCodeSessionId))) {
          report.skipped += 1; idx[item.file] = stamp; continue;
        }
        let m = match(chat);
        if (!m.projectId && cfg.createProjects !== false) {
          const root = await projectRootFor(chat.cwd || chat.projectRoot);
          if (root && await registerFolder(settings, root, { via: 'history' })) {
            projects = await listProjects(settings);
            match = projectMatcher(projects);
            m = match(chat);
            if (m.projectId) report.newProjects = [...(report.newProjects || []), projects.find((p) => p.id === m.projectId)?.name];
          }
        }
        tally(report, item.source, await saveImported(item.source, chat, m, opts), m, projects);
        idx[item.file] = stamp;
      } catch (e) {
        report.errors.push(`${path.basename(item.file)}: ${e.message}`);
      }
    }
    await writeIndex(idx);
    report.at = new Date().toISOString();
    return report;
  })().finally(() => { running = null; });
  return running;
}

/** Imports an export file: its parsed JSON or text, or a path to a file or an unzipped export folder. */
export async function importExport(settings, { content, path: p } = {}) {
  const report = emptyReport();
  const docs = [];
  if (content != null) docs.push({ name: 'upload', text: content });
  if (p) {
    const target = path.resolve(expand(p));
    const st = await fs.stat(target).catch(() => null);
    if (!st) throw Object.assign(new Error(`Not found: ${p}`), { status: 404 });
    if (st.isDirectory()) {
      for (const f of await findExportFiles(target)) docs.push({ name: f, text: await fs.readFile(f, 'utf8') });
      if (!docs.length) throw Object.assign(new Error('No conversations.json or MyActivity.json found in that folder.'), { status: 400 });
    } else docs.push({ name: target, text: await fs.readFile(target, 'utf8') });
  }
  const projects = await listProjects(settings);
  const match = projectMatcher(projects);
  for (const d of docs) {
    let data;
    try { data = typeof d.text === 'string' ? JSON.parse(d.text) : d.text; } catch {
      report.errors.push(`${path.basename(d.name)}: not JSON. For Google Takeout, choose JSON as the My Activity format.`);
      continue;
    }
    const { source, chats } = parseExport(data);
    if (!source) { report.errors.push(`${path.basename(d.name)}: not a claude.ai or Gemini export.`); continue; }
    for (const chat of chats) {
      const m = match(chat);
      tally(report, source, await saveImported(source, chat, m), m, projects);
    }
  }
  report.at = new Date().toISOString();
  return report;
}

async function findExportFiles(dir, depth = 0, out = []) {
  if (depth > 5 || out.length > 20) return out;
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await findExportFiles(full, depth + 1, out);
    else if (e.name === 'conversations.json' || (e.name === 'MyActivity.json' && /gemini|bard/i.test(dir))) out.push(full);
  }
  return out;
}

/** What import sources exist on this computer, for the Settings card. */
export async function localSources(settings) {
  const cfg = settings.history || {};
  const cc = expand(cfg.claudeCodeDir) || path.join(os.homedir(), '.claude', 'projects');
  const gem = expand(cfg.geminiDir) || path.join(os.homedir(), '.gemini', 'tmp');
  return {
    claudeCode: { dir: cc, found: await exists(cc) },
    geminiCli: { dir: gem, found: await exists(gem) },
  };
}

export const _test = { projectMatcher, importId };
