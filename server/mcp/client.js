import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readSSE } from '../sse.js';

/**
 * Minimal MCP client: stdio and Streamable HTTP transports, enough for
 * initialize, tools/list and tools/call. One client per configured server.
 */
const PROTOCOL = '2025-06-18';
const INFO = { name: 'ynros-harness', version: '0.1.0' };

class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.on('error', (e) => this.fail(e));
    this.child.on('close', (code) => this.fail(new Error(`MCP server exited (${code}). ${this.stderr.trim().slice(-500)}`)));
    this.child.stdin.on('error', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = msg.id !== undefined && this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }

  fail(err) {
    this.closed = true;
    this.error = err;
    for (const p of this.pending.values()) p({ error: { message: err.message } });
    this.pending.clear();
  }

  request(msg, timeoutMs) {
    if (this.closed) return Promise.reject(this.error || new Error('MCP server is not running'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(msg.id); reject(new Error(`MCP request timed out: ${msg.method}`)); }, timeoutMs);
      this.pending.set(msg.id, (res) => { clearTimeout(t); resolve(res); });
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  notify(msg) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(msg)}\n`); }

  close() { this.closed = true; try { this.child.kill(); } catch { /* gone */ } }
}

class HttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
  }

  async post(msg, timeoutMs) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401) throw new Error('The MCP server needs authorization. Add a token in its headers.');
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async request(msg, timeoutMs) {
    const res = await this.post(msg, timeoutMs);
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for await (const { data } of readSSE(res.body)) {
        if (data && typeof data === 'object' && data.id === msg.id) return data;
      }
      throw new Error('MCP stream ended without a response');
    }
    return res.json();
  }

  notify(msg) { this.post(msg, 10_000).catch(() => {}); }

  close() {
    if (this.sessionId) fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.headers } }).catch(() => {});
  }
}

export class McpClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.seq = 0;
    this.ready = null;
  }

  connect() {
    this.ready ||= (async () => {
      const c = this.config;
      this.transport = c.url
        ? new HttpTransport({ url: c.url, headers: c.headers })
        : new StdioTransport({ command: c.command, args: c.args, env: c.env, cwd: c.cwd });
      const init = await this.call('initialize', {
        protocolVersion: PROTOCOL, capabilities: {}, clientInfo: INFO,
      }, 30_000);
      this.serverInfo = init.serverInfo;
      this.transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return this;
    })().catch((e) => { this.ready = null; this.close(); throw e; });
    return this.ready;
  }

  async call(method, params, timeoutMs = 120_000) {
    const res = await this.transport.request({ jsonrpc: '2.0', id: ++this.seq, method, params }, timeoutMs);
    if (res.error) throw new Error(`${this.name}: ${res.error.message}`);
    return res.result;
  }

  async listTools() {
    await this.connect();
    const tools = [];
    let cursor;
    do {
      const r = await this.call('tools/list', cursor ? { cursor } : {}, 30_000);
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  async callTool(name, args) {
    await this.connect();
    const r = await this.call('tools/call', { name, arguments: args || {} });
    const text = (r.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return c.resource?.text || `[resource ${c.resource?.uri}]`;
      return `[${c.type} content]`;
    }).join('\n');
    const out = r.structuredContent && !text ? JSON.stringify(r.structuredContent) : text;
    if (r.isError) throw new Error(out || 'Tool failed');
    return out;
  }

  close() { try { this.transport?.close(); } catch { /* ignore */ } this.ready = null; }
}
