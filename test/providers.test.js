import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSSE } from '../server/sse.js';
import * as anthropic from '../server/providers/anthropic.js';
import * as gemini from '../server/providers/gemini.js';
import * as claudeCode from '../server/providers/claudeCode.js';
import { defaultSettings } from '../server/settings.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

function sseResponse(events) {
  const text = events.map((e) => `event: ${e.type || 'message'}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // Split into awkward chunks to exercise buffering.
  const chunks = text.match(/[\s\S]{1,7}/g);
  return new Response(new ReadableStream({
    start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); },
  }));
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('readSSE parses events across chunk boundaries', async () => {
  const res = sseResponse([{ type: 'a', n: 1 }, { type: 'b', n: 2 }]);
  const got = await collect(readSSE(res.body));
  assert.deepEqual(got.map((g) => g.data.n), [1, 2]);
  assert.equal(got[0].event, 'a');
});

test('anthropic: builds request and streams text', async () => {
  const settings = defaultSettings();
  settings.anthropic.apiKey = 'sk-test';
  settings.anthropic.systemPrompt = 'be brief';
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
  };
  const events = await collect(anthropic.stream({
    settings,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }],
    model: 'claude-haiku-5-5',
    fetchImpl,
  }));
  assert.match(captured.url, /\/v1\/messages$/);
  assert.equal(captured.opts.headers['x-api-key'], 'sk-test');
  assert.equal(captured.body.model, 'claude-haiku-5-5');
  assert.equal(captured.body.system, 'be brief');
  assert.equal(captured.body.messages.length, 3);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello');
  assert.deepEqual(events.at(-1).usage, { input: 10, output: 2 });
});

test('anthropic: surfaces HTTP errors and missing keys', async () => {
  const settings = defaultSettings();
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(collect(anthropic.stream({ settings, messages: [] })), /No Anthropic API key/);
  settings.anthropic.apiKey = 'bad';
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  await assert.rejects(collect(anthropic.stream({ settings, messages: [{ role: 'user', content: 'x' }], fetchImpl })), /401: invalid x-api-key/);
});

test('anthropic: history merges same-role turns and starts with user', () => {
  const out = anthropic.toApiMessages([
    { role: 'assistant', content: 'orphan' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: '' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'a\n\nb' }]);
});

test('gemini: builds request and streams text', async () => {
  const settings = defaultSettings();
  settings.gemini.apiKey = 'AIza-test';
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return sseResponse([
      { candidates: [{ content: { parts: [{ text: 'Bon' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'jour' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ]);
  };
  const events = await collect(gemini.stream({
    settings, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }], fetchImpl,
  }));
  assert.match(captured.url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(captured.opts.headers['x-goog-api-key'], 'AIza-test');
  assert.deepEqual(captured.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Bonjour');
  assert.deepEqual(events.at(-1).usage, { input: 5, output: 2 });
});

test('gemini: listModels keeps only generateContent models', async () => {
  const settings = defaultSettings();
  settings.gemini.apiKey = 'k';
  const fetchImpl = async () => Response.json({
    models: [
      { name: 'models/gemini-x', displayName: 'X', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
    ],
  });
  assert.deepEqual(await gemini.listModels(settings, fetchImpl), [{ id: 'gemini-x', label: 'X' }]);
});

test('claudeCode: buildArgs maps settings to CLI flags', () => {
  const settings = defaultSettings();
  Object.assign(settings.claudeCode, { permissionMode: 'acceptEdits', allowedTools: 'Read, Grep', systemPrompt: 'hi' });
  const args = claudeCode.buildArgs({ settings, model: 'opus', sessionId: 'abc' });
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  for (const pair of [['--model', 'opus'], ['--resume', 'abc'], ['--permission-mode', 'acceptEdits'], ['--append-system-prompt', 'hi']]) {
    assert.equal(args[args.indexOf(pair[0]) + 1], pair[1]);
  }
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['Read', 'Grep']);
});

test('claudeCode: streams text, tools and session id from the CLI', async () => {
  const settings = defaultSettings();
  settings.claudeCode.binaryPath = FAKE_CLAUDE;
  const events = await collect(claudeCode.stream({
    settings, messages: [{ role: 'user', content: 'ping' }], conversation: { claudeCodeSessionId: 'old-1' },
  }));
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'echo: ping (resumed old-1)'); // partial deltas only, no duplicate full text
  assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', name: 'Bash', input: 'ls' });
  assert.equal(events.find((e) => e.type === 'tool_result').text, 'file.txt');
  assert.equal(events.at(-1).sessionId, 'old-1');
  assert.equal(events.at(-1).costUsd, 0.0012);
});

test('claudeCode: test() reports version or a helpful error', async () => {
  const settings = defaultSettings();
  settings.claudeCode.binaryPath = FAKE_CLAUDE;
  assert.deepEqual(await claudeCode.test(settings), { ok: true, message: 'Found 9.9.9 (Fake Claude Code)' });
  settings.claudeCode.binaryPath = '/nonexistent/claude';
  const r = await claudeCode.test(settings);
  assert.equal(r.ok, false);
  assert.match(r.message, /Is Claude Code installed/);
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** A stand-in child process that prints the given stream-json events. */
function scriptedSpawn(events) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => {
      for (const e of events) child.stdout.write(`${JSON.stringify(e)}\n`);
      child.stdout.end();
      child.exitCode = 0;
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

test('claudeCode: tracks subagents through their lifecycle (shape from CLI 2.1)', async () => {
  const settings = defaultSettings();
  const T = 'toolu_agent1';
  const events = await collect(claudeCode.stream({
    settings,
    messages: [{ role: 'user', content: 'go' }],
    spawnImpl: scriptedSpawn([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: T, name: 'Agent', input: { description: 'List dir', subagent_type: 'Explore', prompt: 'ls' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: T, description: 'List dir', subagent_type: 'Explore', is_backgrounded: false },
      { type: 'system', subtype: 'task_progress', task_id: 'a1', tool_use_id: T, description: 'Running ls', usage: { tool_uses: 1, total_tokens: 900 } },
      { type: 'assistant', parent_tool_use_id: T, message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', parent_tool_use_id: T, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a.txt' }] } },
      { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: T, content: [{ type: 'text', text: 'found a.txt' }] }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
    ]),
  }));
  const subs = events.filter((e) => e.type === 'subagent');
  assert.ok(subs.every((e) => e.id === T), 'all keyed by the Agent tool_use id');
  assert.equal(subs[0].status, 'running');
  assert.equal(subs[0].agentType, 'Explore');
  assert.ok(subs.some((e) => e.activity === 'Running ls' && e.toolUses === 1));
  assert.ok(subs.some((e) => e.activity === 'Bash ls'));
  assert.equal(subs.filter((e) => e.status === 'done').length >= 1, true);
  // Subagent internals never leak into the main transcript.
  assert.equal(events.filter((e) => e.type === 'tool' || e.type === 'tool_result').length, 0);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Done.');
});

test('claudeCode: background subagents stay running until their task event', async () => {
  const settings = defaultSettings();
  const T = 'toolu_bg';
  const events = await collect(claudeCode.stream({
    settings,
    messages: [{ role: 'user', content: 'go' }],
    spawnImpl: scriptedSpawn([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: T, name: 'Agent', input: { description: 'bg', run_in_background: true } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: T, content: 'Async agent launched' }] } },
      { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: T, status: 'failed', summary: 'boom' },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
    ]),
  }));
  const statuses = events.filter((e) => e.type === 'subagent' && e.status).map((e) => e.status);
  assert.deepEqual(statuses, ['running', 'failed']);
  assert.equal(events.find((e) => e.status === 'failed').result, 'boom');
});

test('claudeCode: skills show as a skill event carrying the injected text', async () => {
  const settings = defaultSettings();
  const events = await collect(claudeCode.stream({
    settings,
    messages: [{ role: 'user', content: 'greet me' }],
    spawnImpl: scriptedSpawn([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'greet' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sk1', content: 'Launching skill: greet' }] } },
      { type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /p/.claude/skills/greet\n\n# Greeting skill\nSay hi.\n' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
    ]),
  }));
  const skills = events.filter((e) => e.type === 'skill');
  assert.equal(skills.length, 2);
  assert.equal(skills[0].name, 'greet');
  assert.equal(skills[0].text, null);
  assert.equal(skills[1].id, 'sk1');
  assert.equal(skills[1].text, '# Greeting skill\nSay hi.\n');
  assert.equal(skills[1].path, '/p/.claude/skills/greet');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 0, '"Launching skill" is not shown');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hi!');
});
