#!/usr/bin/env node
// A tiny MCP server (stdio, JSON-RPC 2.0) that Claude Code launches. It
// forwards tool calls to the harness, so Claude Code gets the same Google,
// Gmail, Drive and calendar tools as the API providers.
import readline from 'node:readline';

const BASE = process.env.HARNESS_URL;
const TOKEN = process.env.HARNESS_TOKEN;

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-harness-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harness', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      const { tools } = await call('/api/tools?for=claudeCode');
      send({ id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) } });
    } else if (method === 'tools/call') {
      try {
        const r = await call(`/api/tools/${encodeURIComponent(params.name)}`, params.arguments || {});
        send({ id, result: { content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 1) }] } });
      } catch (e) {
        send({ id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ id, error: { code: -32000, message: e.message } });
  }
});
