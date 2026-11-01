import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
let server; let base; let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  process.env.HARNESS_DATA_DIR = dataDir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  const { createServer } = await import('../server/index.js');
  server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // Re-create with the real port so the Host check matches.
  server.close();
  server = createServer({ port });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://localhost:${port}`;
});
after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function sendAndStream(id, text) {
  const res = await fetch(`${base}/api/conversations/${id}/messages`, json('POST', { text }));
  assert.equal(res.status, 202);
  const stream = await fetch(`${base}/api/conversations/${id}/stream`);
  assert.equal(stream.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  return (await stream.text()).trim().split('\n').map((l) => JSON.parse(l));
}

const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('serves the UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Harness<\/title>/);
});

test('rejects foreign Host and Origin headers', async () => {
  const { request } = await import('node:http');
  const status = (headers) => new Promise((resolve, reject) => {
    const req = request(`${base}/api/settings`, { headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await status({ host: 'evil.example' }), 403);
  assert.equal(await status({ origin: 'https://evil.example' }), 403);
});

test('settings never return API keys', async () => {
  let res = await fetch(`${base}/api/settings`, json('PUT', { anthropic: { apiKey: 'sk-ant-secret1234', model: 'claude-opus-5-5' } }));
  let s = await res.json();
  assert.equal(s.anthropic.hasKey, true);
  assert.equal(s.anthropic.keyHint, '…1234');
  assert.equal(s.anthropic.apiKey, undefined);
  assert.ok(!JSON.stringify(s).includes('secret'));

  // Blank key leaves it alone; clearApiKey removes it.
  res = await fetch(`${base}/api/settings`, json('PUT', { anthropic: { apiKey: '' } }));
  assert.equal((await res.json()).anthropic.hasKey, true);
  res = await fetch(`${base}/api/settings`, json('PUT', { anthropic: { clearApiKey: true } }));
  s = await res.json();
  assert.equal(s.anthropic.hasKey, false);
  assert.equal(s.anthropic.model, 'claude-opus-5-5');

  const stat = await fs.stat(path.join(dataDir, 'settings.json'));
  assert.equal(stat.mode & 0o077, 0, 'settings file is private to the user');
});

test('rejects writes without a JSON content type', async () => {
  const res = await fetch(`${base}/api/settings`, { method: 'PUT', body: 'x=1', headers: { 'content-type': 'text/plain' } });
  assert.equal(res.status, 415);
});

test('full chat round trip through Claude Code, with session resume', async () => {
  await fetch(`${base}/api/settings`, json('PUT', { claudeCode: { binaryPath: FAKE_CLAUDE, workingDirectory: dataDir } }));
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode', model: '' }))).json();

  const chat = (text) => sendAndStream(conv.id, text);

  let events = await chat('hello');
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].conversation.title, 'hello');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.message.content, 'echo: hello');
  assert.equal(done.message.costUsd, 0.0012);

  events = await chat('again');
  assert.equal(events.at(-1).message.content, 'echo: again (resumed sess-123)');

  const saved = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
  assert.equal(saved.claudeCodeSessionId, 'sess-123');
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(saved.messages[1].events[0].name, 'Bash');

  const list = await (await fetch(`${base}/api/conversations`)).json();
  assert.equal(list[0].id, conv.id);
});

test('missing API key yields a readable error in the stream', async () => {
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'gemini' }))).json();
  const events = await sendAndStream(conv.id, 'hi');
  assert.match(events.find((e) => e.type === 'error').message, /No Gemini API key/);
  assert.match(events.at(-1).message.error, /No Gemini API key/);
});

test('models endpoint falls back to built-in list without a key', async () => {
  const r = await (await fetch(`${base}/api/models/anthropic`)).json();
  assert.equal(r.live, false);
  assert.ok(r.models.some((m) => m.id === 'claude-sonnet-5-5'));
});

test('delete removes a conversation', async () => {
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', {}))).json();
  await fetch(`${base}/api/conversations/${conv.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${base}/api/conversations/${conv.id}`)).status, 404);
});

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('messages sent while running are queued, triaged, then sent as one batch', async () => {
  await fetch(`${base}/api/settings`, json('PUT', { claudeCode: { binaryPath: FAKE_CLAUDE, workingDirectory: dataDir } }));
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode' }))).json();
  const post = (text) => fetch(`${base}/api/conversations/${conv.id}/messages`, json('POST', { text })).then((r) => r.json());

  assert.ok((await post('slow task')).runId);
  const q1 = await post('also do A');
  const q2 = await post('and B');
  assert.equal(q1.queued, true);
  assert.equal(q2.queued, true);

  // Triage runs on the small model; both should come back "queue".
  await waitFor(async () => {
    const c = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return c.queue?.length === 2 && c.queue.every((q) => q.triage.status === 'done') && c;
  });

  // When the first run ends, the queue is sent as one batched turn.
  const final = await waitFor(async () => {
    const c = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return !c.running && c.messages.length === 4 && c;
  });
  assert.deepEqual(final.messages[2].batch, ['also do A', 'and B']);
  assert.match(final.messages[2].content, /1\. also do A\n\n2\. and B/);
  assert.equal(final.queue.length, 0);
});

test('triage can recommend an interrupt, and only the user triggers it', async () => {
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode' }))).json();
  const post = (text) => fetch(`${base}/api/conversations/${conv.id}/messages`, json('POST', { text })).then((r) => r.json());
  await post('slow job');
  const { item } = await post('STOP, wrong folder');
  const c = await waitFor(async () => {
    const x = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return x.queue?.[0]?.triage?.status === 'done' && x;
  });
  assert.equal(c.queue[0].triage.decision, 'interrupt');
  assert.equal(c.running, true, 'still running until the user confirms');

  await fetch(`${base}/api/conversations/${conv.id}/queue/${item.id}/send`, json('POST', {}));
  const done = await waitFor(async () => {
    const x = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return !x.running && x.messages.length === 4 && x;
  });
  assert.equal(done.messages[1].stopped, true);
  assert.equal(done.messages[2].content, 'STOP, wrong folder');
});

test('files: list, read and save Markdown inside the folder only', async () => {
  const root = path.join(dataDir, 'notes');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'sub', 'a.md'), '# A');
  await fs.writeFile(path.join(root, 'secret.json'), '{}');
  await fetch(`${base}/api/settings`, json('PUT', { files: { root } }));

  const list = await (await fetch(`${base}/api/files`)).json();
  assert.deepEqual(list.files.map((f) => f.path), [path.join('sub', 'a.md')]);

  const file = await (await fetch(`${base}/api/files/content?path=sub/a.md`)).json();
  assert.equal(file.content, '# A');

  let res = await fetch(`${base}/api/files/content`, json('PUT', { path: 'sub/a.md', content: '# B', expectedMtime: file.mtime }));
  assert.equal(res.status, 200);
  assert.equal(await fs.readFile(path.join(root, 'sub', 'a.md'), 'utf8'), '# B');

  res = await fetch(`${base}/api/files/content`, json('PUT', { path: 'sub/a.md', content: '# C', expectedMtime: file.mtime }));
  assert.equal(res.status, 409, 'stale save is refused');

  assert.equal((await fetch(`${base}/api/files/content?path=../settings.json`)).status, 403);
  assert.equal((await fetch(`${base}/api/files/content?path=secret.json`)).status, 415);
});

test('tool endpoint for the Claude Code bridge requires its token', async () => {
  const { local } = await import('../server/local.js');
  assert.equal((await fetch(`${base}/api/tools`)).status, 401);
  const res = await fetch(`${base}/api/tools`, { headers: { 'x-harness-token': local.token } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).tools));
});

test('integrations status reports Google redirect URI and ICS feeds', async () => {
  await fetch(`${base}/api/settings`, json('PUT', { calendars: { icsFeeds: 'Work | https://example.com/w.ics' } }));
  const r = await (await fetch(`${base}/api/integrations`)).json();
  assert.equal(r.google.connected, false);
  assert.match(r.google.redirectUri, /^http:\/\/localhost:\d+\/api\/google\/callback$/);
  assert.deepEqual(r.icsFeeds, [{ id: 'ics:1', name: 'Work' }]);
  assert.ok(r.tools.includes('list_calendar_events'));
  assert.ok(!r.tools.includes('gmail_search'), 'Gmail tools only appear once Google is connected');
});

test('projects: create a folder with CLAUDE.md and outputs, chats use it, @mentions resolve', async () => {
  const host = path.join(dataDir, 'host');
  await fetch(`${base}/api/settings`, json('PUT', { projects: { hostFolder: host }, claudeCode: { binaryPath: FAKE_CLAUDE } }));
  const res = await fetch(`${base}/api/projects`, json('POST', { name: 'Trip Planning' }));
  assert.equal(res.status, 201);
  const project = await res.json();
  assert.equal(project.path, path.join(host, 'Trip Planning'));
  assert.match(await fs.readFile(path.join(project.path, 'CLAUDE.md'), 'utf8'), /# Trip Planning/);
  assert.ok((await fs.stat(path.join(project.path, 'outputs'))).isDirectory());

  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.lastProjectId, project.id);
  assert.equal(list.hostFolder, host);

  await fs.writeFile(path.join(project.path, 'itinerary.md'), 'Day 1: Lisbon');
  const m = await (await fetch(`${base}/api/mentions?project=${project.id}&q=itin`)).json();
  assert.deepEqual(m.files.map((f) => f.path), ['itinerary.md']);

  // Claude Code runs inside the project folder and the mention is recorded.
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode', projectId: project.id }))).json();
  assert.equal(conv.projectId, project.id);
  await sendAndStream(conv.id, 'summarize @itinerary.md please');
  const saved = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
  assert.deepEqual(saved.messages[0].attachments, ['itinerary.md']);
  assert.equal(saved.messages[0].providerContent, undefined, 'Claude Code reads files itself');

  // Files view is scoped to the project.
  const filesRes = await (await fetch(`${base}/api/files?project=${project.id}`)).json();
  assert.ok(filesRes.files.some((f) => f.path === 'CLAUDE.md'));

  assert.equal((await fetch(`${base}/api/projects`, json('POST', { name: 'Trip Planning' }))).status, 409);
});

test('quota: a usage limit parks the work, queues a continue, and offers other providers', async () => {
  await fetch(`${base}/api/settings`, json('PUT', { claudeCode: { binaryPath: FAKE_CLAUDE, workingDirectory: dataDir }, gemini: { apiKey: 'g-key' } }));
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode' }))).json();
  await sendAndStream(conv.id, 'please hit limit');
  const held = await waitFor(async () => {
    const c = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return !c.running && c.quotaHold && c;
  });
  assert.equal(held.quotaHold.reason, 'exhausted');
  assert.ok(held.quotaHold.resetsAt > Date.now());
  assert.ok(held.quotaHold.alternatives.some((a) => a.provider === 'gemini'));
  assert.equal(held.queue[0].auto, true);
  assert.equal(held.messages[1].quotaLimited, true);

  // New messages wait too, instead of failing.
  const r = await (await fetch(`${base}/api/conversations/${conv.id}/messages`, json('POST', { text: 'and this' }))).json();
  assert.equal(r.queued, true);

  const q = await (await fetch(`${base}/api/quota`)).json();
  assert.equal(q.claudeCode.exhausted, true);

  // Switching provider sends what was waiting (it fails here: the Gemini key is fake, which is fine).
  await fetch(`${base}/api/conversations/${conv.id}/switch`, json('POST', { provider: 'gemini' }));
  const moved = await waitFor(async () => {
    const c = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    return !c.running && c.messages.length === 4 && c;
  });
  assert.equal(moved.provider, 'gemini');
  assert.equal(moved.quotaHold, null);
  assert.deepEqual(moved.messages[2].batch.length, 2);
  // Reset for later tests.
  (await import('../server/quota.js'))._reset();
  await fetch(`${base}/api/settings`, json('PUT', { gemini: { clearApiKey: true } }));
});

test('mcp: add a stdio server; API models see its tools and can call them', async () => {
  const echo = path.join(path.dirname(FAKE_CLAUDE), 'echo-mcp.mjs');
  let res = await fetch(`${base}/api/mcp`, json('POST', { name: 'echo', config: { command: process.execPath, args: [echo] } }));
  assert.equal(res.status, 201);
  const tools = await (await fetch(`${base}/api/mcp/echo/tools`)).json();
  assert.deepEqual(tools.tools.map((t) => t.name), ['shout']);

  const { availableTools, runTool } = await import('../server/tools.js');
  const { loadSettings } = await import('../server/settings.js');
  const settings = await loadSettings();
  const api = await availableTools(settings);
  assert.ok(api.tools.some((t) => t.name === 'mcp__echo__shout'));
  assert.equal(await runTool('mcp__echo__shout', { text: 'hi' }, settings), 'HI');
  const cc = await availableTools(settings, { forClaudeCode: true });
  assert.ok(!cc.tools.some((t) => t.name.startsWith('mcp__')), 'Claude Code gets MCP servers directly');

  res = await fetch(`${base}/api/mcp`, json('POST', { name: 'bad name!', config: { command: 'x' } }));
  assert.equal(res.status, 400);
  await fetch(`${base}/api/mcp/echo`, { method: 'DELETE' });
  assert.equal((await (await fetch(`${base}/api/mcp`)).json()).servers.length, 0);
});

test('auto model: routes per message, stays sticky, and suggests a fresh chat for a new topic', async () => {
  await fetch(`${base}/api/settings`, json('PUT', { claudeCode: { binaryPath: FAKE_CLAUDE, workingDirectory: dataDir } }));
  const conv = await (await fetch(`${base}/api/conversations`, json('POST', { provider: 'claudeCode', model: 'auto' }))).json();

  let events = await sendAndStream(conv.id, 'quick question');
  let routed = events.find((e) => e.type === 'routed');
  assert.equal(routed.tier, 'small');
  assert.equal(routed.model, 'haiku');

  events = await sendAndStream(conv.id, 'now a hard refactor');
  routed = events.find((e) => e.type === 'routed');
  assert.equal(routed.model, 'opus', 'moves up a tier when needed');

  events = await sendAndStream(conv.id, 'another quick one');
  assert.equal(events.find((e) => e.type === 'routed').model, 'opus', 'does not drop back mid-chat (keeps the cache)');

  events = await sendAndStream(conv.id, 'something unrelated: plan my vacation');
  assert.ok(events.some((e) => e.type === 'suggest_new_chat'));
  const c = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
  assert.ok(c.suggestNewChat);
  assert.equal(c.model, 'auto');

  const moved = await (await fetch(`${base}/api/conversations/${conv.id}/new-chat`, json('POST', {}))).json();
  const fresh = await waitFor(async () => {
    const x = await (await fetch(`${base}/api/conversations/${moved.id}`)).json();
    return !x.running && x.messages.length === 2 && x;
  });
  assert.match(fresh.messages[0].content, /plan my vacation/);
  const old = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
  assert.equal(old.messages.length, 6);
  assert.equal(old.suggestNewChat, null);
});

test('today: lists chats needing attention and starts a brief', async () => {
  const t = await (await fetch(`${base}/api/today`)).json();
  assert.ok(Array.isArray(t.attention));
  assert.ok(Array.isArray(t.recent));
  assert.equal(t.mail, null, 'no Gmail without Google');
  const r = await (await fetch(`${base}/api/today/brief`, json('POST', {}))).json();
  const c = await waitFor(async () => {
    const x = await (await fetch(`${base}/api/conversations/${r.id}`)).json();
    return !x.running && x.messages.length === 2 && x;
  });
  assert.match(c.title, /^Brief/);
  assert.match(c.messages[0].content, /brief for today/);
});
