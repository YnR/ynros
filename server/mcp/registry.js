import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../settings.js';
import { McpClient } from './client.js';

/**
 * The harness's own list of MCP servers, shared by every provider:
 *  - API models (Claude API, Gemini) call them through the harness's MCP client;
 *  - Claude Code gets them through --mcp-config.
 * Servers can be added by hand, from Claude Code's plugin marketplace, or from
 * a Gemini CLI extension (gemini-extension.json).
 */
const FILE = () => path.join(DATA_DIR, 'mcp.json');
const clients = new Map(); // name -> McpClient
const toolCache = new Map(); // name -> { at, tools, error }

export async function loadRegistry() {
  try { return JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch { return { servers: {} }; }
}

async function saveRegistry(reg) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE(), JSON.stringify(reg, null, 2), { mode: 0o600 });
}

export function validName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name);
}

function normalize(cfg) {
  const out = {};
  if (cfg.url || cfg.httpUrl) {
    out.url = cfg.url || cfg.httpUrl;
    if (cfg.headers && typeof cfg.headers === 'object') out.headers = cfg.headers;
  } else if (cfg.command) {
    out.command = String(cfg.command);
    out.args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    if (cfg.env && typeof cfg.env === 'object') out.env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]));
    if (cfg.cwd) out.cwd = String(cfg.cwd);
  } else {
    throw Object.assign(new Error('An MCP server needs a command (stdio) or a url (HTTP)'), { status: 400 });
  }
  return out;
}

export async function addServer(name, config, { source = 'manual', enabled = true, confirm = false } = {}) {
  if (!validName(name)) throw Object.assign(new Error('Use letters, numbers, - and _ for the server name'), { status: 400 });
  const reg = await loadRegistry();
  reg.servers[name] = { ...normalize(config), source, enabled, confirm: Boolean(confirm || config.confirm) };
  await saveRegistry(reg);
  reset(name);
  return reg.servers[name];
}

export async function removeServer(name) {
  const reg = await loadRegistry();
  delete reg.servers[name];
  await saveRegistry(reg);
  reset(name);
}

/** One-click presets. */
export const PRESETS = {
  chrome: {
    name: 'chrome',
    label: 'Chrome (DevTools MCP)',
    config: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    confirm: true,
    note: 'Controls a Chrome window: open pages, click, fill forms, read content. Every action asks you first.',
  },
};

export async function addPreset(id) {
  const p = PRESETS[id];
  if (!p) throw Object.assign(new Error('Unknown preset'), { status: 404 });
  return addServer(p.name, p.config, { source: `preset:${id}`, confirm: p.confirm });
}

export async function setConfirm(name, confirm) {
  const reg = await loadRegistry();
  if (!reg.servers[name]) throw Object.assign(new Error('No such server'), { status: 404 });
  reg.servers[name].confirm = Boolean(confirm);
  await saveRegistry(reg);
}

export async function setEnabled(name, enabled) {
  const reg = await loadRegistry();
  if (!reg.servers[name]) throw Object.assign(new Error('No such server'), { status: 404 });
  reg.servers[name].enabled = Boolean(enabled);
  await saveRegistry(reg);
  reset(name);
}

function reset(name) {
  clients.get(name)?.close();
  clients.delete(name);
  toolCache.delete(name);
}

function client(name, cfg) {
  if (!clients.has(name)) clients.set(name, new McpClient(name, cfg));
  return clients.get(name);
}

export async function serverTools(name, { refresh = false } = {}) {
  const reg = await loadRegistry();
  const cfg = reg.servers[name];
  if (!cfg) throw Object.assign(new Error('No such server'), { status: 404 });
  const hit = toolCache.get(name);
  if (hit && !refresh && Date.now() - hit.at < 5 * 60_000) return hit;
  try {
    const tools = await client(name, cfg).listTools();
    const entry = { at: Date.now(), tools };
    toolCache.set(name, entry);
    return entry;
  } catch (e) {
    reset(name);
    const entry = { at: Date.now(), tools: [], error: e.message };
    toolCache.set(name, entry);
    return entry;
  }
}

/** Gemini function names: ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$ (Anthropic allows 64 chars too). */
function toolId(server, tool) {
  const id = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return id.length <= 64 ? id : `${id.slice(0, 55)}_${Math.abs(hash(id)).toString(36).slice(0, 8)}`;
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

/** Tool definitions (harness format) from all enabled servers, for API models. */
export async function apiTools() {
  const reg = await loadRegistry();
  const out = [];
  await Promise.all(Object.entries(reg.servers).filter(([, c]) => c.enabled !== false).map(async ([name]) => {
    const { tools } = await serverTools(name);
    for (const t of tools) {
      out.push({
        name: toolId(name, t.name),
        group: 'mcp',
        description: `[${name}] ${t.description || t.name}`.slice(0, 1024),
        schema: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        mcp: { server: name, tool: t.name },
        confirm: Boolean(reg.servers[name].confirm),
      });
    }
  }));
  return out;
}

export async function callTool(server, tool, args) {
  const reg = await loadRegistry();
  const cfg = reg.servers[server];
  if (!cfg || cfg.enabled === false) throw new Error(`MCP server ${server} is not enabled`);
  return client(server, cfg).callTool(tool, args);
}

/** Servers for Claude Code's --mcp-config (plugin servers are already loaded by Claude Code itself). */
export async function claudeCodeServers() {
  const reg = await loadRegistry();
  const out = {};
  for (const [name, c] of Object.entries(reg.servers)) {
    if (c.enabled === false || String(c.source).startsWith('claude-plugin:')) continue;
    out[name] = c.url
      ? { type: 'http', url: c.url, ...(c.headers ? { headers: c.headers } : {}) }
      : { command: c.command, args: c.args || [], ...(c.env ? { env: c.env } : {}) };
  }
  return out;
}

/* ---------- Claude Code plugin marketplace ---------- */

function runCli(bin, args, { timeout = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(bin, args, { cwd, env: process.env });
    const t = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error(`"${bin}" is not installed or not on PATH`) : e); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().slice(-800) || `${bin} exited with ${code}`));
    });
  });
}

export async function claudeMarketplace(settings) {
  const bin = settings.claudeCode.binaryPath || 'claude';
  const [plugins, markets] = await Promise.all([
    runCli(bin, ['plugin', 'list', '--available', '--json']).then(JSON.parse),
    runCli(bin, ['plugin', 'marketplace', 'list', '--json']).then(JSON.parse).catch(() => []),
  ]);
  const installed = new Set((plugins.installed || []).map((p) => p.id));
  return {
    marketplaces: markets,
    installed: plugins.installed || [],
    available: (plugins.available || []).map((p) => ({
      id: p.pluginId, name: p.name, description: p.description, marketplace: p.marketplaceName,
      version: p.version, installed: installed.has(p.pluginId),
    })),
  };
}

export async function claudeAddMarketplace(settings, source) {
  if (!source || /^\s*-/.test(source)) throw Object.assign(new Error('Give a marketplace URL, path or owner/repo'), { status: 400 });
  return runCli(settings.claudeCode.binaryPath || 'claude', ['plugin', 'marketplace', 'add', source]);
}

/**
 * Install a plugin into Claude Code, then import any MCP servers it ships
 * (.mcp.json) into the registry so the API models can use them too.
 */
export async function claudeInstallPlugin(settings, pluginId) {
  if (!/^[\w.-]+(@[\w.-]+)?$/.test(pluginId || '')) throw Object.assign(new Error('Bad plugin id'), { status: 400 });
  const bin = settings.claudeCode.binaryPath || 'claude';
  const log = await runCli(bin, ['plugin', 'install', pluginId]);
  const list = JSON.parse(await runCli(bin, ['plugin', 'list', '--json']));
  const plugin = (list.installed || list).find?.((p) => p.id === pluginId || p.id?.startsWith(`${pluginId}@`));
  const imported = [];
  if (plugin?.installPath) {
    for (const file of ['.mcp.json', path.join('.claude-plugin', 'plugin.json')]) {
      let json;
      try { json = JSON.parse(await fs.readFile(path.join(plugin.installPath, file), 'utf8')); } catch { continue; }
      const servers = json.mcpServers || (file === '.mcp.json' ? json : null);
      if (!servers || typeof servers !== 'object') continue;
      for (const [name, cfg] of Object.entries(servers)) {
        const sub = (v) => (typeof v === 'string' ? v.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.installPath) : v);
        const fixed = JSON.parse(JSON.stringify(cfg), (_k, v) => sub(v));
        const id = validName(name) ? name : name.replace(/[^\w-]/g, '-').slice(0, 40);
        try { await addServer(id, fixed, { source: `claude-plugin:${pluginId}` }); imported.push(id); } catch { /* skip unusable entries */ }
      }
    }
  }
  return { log: log.trim().slice(-1000), imported };
}

/* ---------- Gemini CLI extensions ---------- */

function rawManifestUrls(url) {
  const u = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (/gemini-extension\.json$/.test(u)) return [u.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')];
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(\/.*)?)?$/);
  if (!m) return [`${u}/gemini-extension.json`];
  const [, owner, repo, ref, sub = ''] = m;
  return (ref ? [ref] : ['HEAD', 'main', 'master']).map((r) => `https://raw.githubusercontent.com/${owner}/${repo}/${r}${sub}/gemini-extension.json`);
}

/**
 * Import the MCP servers of a Gemini CLI extension from its repository's
 * gemini-extension.json. Servers that need the extension's own files are
 * reported, since only the manifest is fetched.
 */
export async function importGeminiExtension(url, fetchImpl = fetch) {
  let manifest = null;
  let lastErr = null;
  for (const u of rawManifestUrls(url)) {
    try {
      const r = await fetchImpl(u);
      if (r.ok) { manifest = await r.json(); break; }
      lastErr = new Error(`${u}: ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  if (!manifest) throw Object.assign(new Error(`Could not read gemini-extension.json (${lastErr?.message})`), { status: 400 });
  const imported = [];
  const skipped = [];
  for (const [name, cfg] of Object.entries(manifest.mcpServers || {})) {
    const usesFiles = JSON.stringify(cfg).includes('${extensionPath}');
    if (usesFiles) { skipped.push({ name, reason: 'needs files from the extension; install it with the Gemini CLI' }); continue; }
    const id = validName(name) ? name : name.replace(/[^\w-]/g, '-').slice(0, 40);
    try {
      await addServer(id, cfg, { source: `gemini-extension:${manifest.name || url}` });
      imported.push(id);
    } catch (e) { skipped.push({ name, reason: e.message }); }
  }
  return { extension: manifest.name, version: manifest.version, imported, skipped, contextFile: manifest.contextFileName || null };
}

export function closeAll() { for (const c of clients.values()) c.close(); clients.clear(); }
export const _homedir = os.homedir;
