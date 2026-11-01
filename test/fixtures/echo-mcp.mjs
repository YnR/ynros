#!/usr/bin/env node
// A tiny stdio MCP server for tests: one tool, "shout".
import readline from 'node:readline';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  else if (method === 'tools/list') send({ id, result: { tools: [{ name: 'shout', description: 'Uppercase text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: String(params.arguments.text).toUpperCase() }] } });
  else send({ id, error: { code: -32601, message: 'nope' } });
});
