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
