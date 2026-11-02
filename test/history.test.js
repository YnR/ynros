import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseClaudeCodeTranscript, parseGeminiSessionLines, parseClaudeExport, parseGeminiTakeout,
  parseExport, importLocal, importExport, projectRootFor,
} from '../server/history.js';
import * as store from '../server/store.js';
import { defaultSettings } from '../server/settings.js';
import { createProject } from '../server/projects.js';

const jl = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n');
const base = { sessionId: 's1', isSidechain: false, cwd: '/w/app', timestamp: '2026-10-01T10:00:00Z' };

const TRANSCRIPT = jl(
  { type: 'last-prompt', sessionId: 's1' },
  { ...base, type: 'user', message: { role: 'user', content: 'Fix the login bug' } },
  { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-x', content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] } },
  { ...base, type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a b' }] } },
  { ...base, type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'k1', name: 'Skill', input: { skill: 'greet' } }] } },
  { ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /s/greet\n\nSay hi.' }] } },
  { ...base, type: 'assistant', message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] } },
  { ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
  { ...base, type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
  { ...base, cwd: '/w/app/sub', type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name><command-args></command-args>' } },
  { type: 'ai-title', aiTitle: 'Old title', sessionId: 's1' },
  { type: 'custom-title', customTitle: 'Login fix', sessionId: 's1' },
  { type: 'ai-title', aiTitle: 'Newer generated title', sessionId: 's1' },
);

test('Claude Code transcript: merges assistant lines, drops tool results, meta and subagent turns', () => {
  const t = parseClaudeCodeTranscript(TRANSCRIPT);
  assert.equal(t.sessionId, 's1');
  assert.equal(t.title, 'Login fix', 'a name the user set wins over generated titles');
  assert.equal(t.cwd, '/w/app', 'most common folder');
  assert.deepEqual(t.messages.map((m) => [m.role, m.content]), [
    ['user', 'Fix the login bug'],
    ['assistant', 'Looking.'],
    ['assistant', ''],
    ['assistant', 'Fixed it.'],
    ['user', '/clear'],
  ]);
  assert.equal(t.messages[1].events[0].name, 'Bash');
  const skill = t.messages[2].events[0];
  assert.equal(skill.type, 'skill');
  assert.equal(skill.text, 'Say hi.', 'skill body is attached to the chip, not shown as a turn');
});

test('Gemini CLI JSONL: merges snapshots by id', () => {
  const raw = jl(
    { sessionId: 'a2a-server', projectHash: 'h', startTime: '2026-10-02T09:00:00Z', lastUpdated: '2026-10-02T09:00:00Z', kind: 'main' },
    { $set: { messages: [{ id: 'u1', type: 'user', timestamp: '2026-10-02T09:00:00Z', content: [{ text: 'Summarise this' }] }] } },
    { $set: { messages: [
      { id: 'u1', type: 'user', timestamp: '2026-10-02T09:00:00Z', content: [{ text: 'Summarise this' }] },
      { id: 'g1', type: 'gemini', timestamp: '2026-10-02T09:00:05Z', content: 'Here you go', model: 'gemini-2.5-pro', thoughts: [{ subject: 'x' }] },
    ], lastUpdated: '2026-10-02T09:00:05Z' } },
    { id: 'u2', type: 'user', timestamp: '2026-10-02T09:01:00Z', content: [{ text: 'Thanks' }] },
  );
  const s = parseGeminiSessionLines(raw);
  assert.deepEqual(s.messages.map((m) => [m.role, m.content]), [['user', 'Summarise this'], ['assistant', 'Here you go'], ['user', 'Thanks']]);
  assert.equal(s.projectHash, 'h');
  assert.equal(s.updatedAt, '2026-10-02T09:00:05.000Z');
});

test('claude.ai export and Gemini Takeout are recognized and parsed', () => {
  const claude = [{ uuid: 'c1', name: 'Trip ideas', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    chat_messages: [{ sender: 'human', text: 'Where in Lisbon?', created_at: '2026-01-01T00:00:00Z' }, { sender: 'assistant', text: 'Alfama.', created_at: '2026-01-01T00:00:01Z' }] }];
  assert.equal(parseExport(claude).source, 'claudeExport');
  assert.equal(parseClaudeExport(claude)[0].messages[1].content, 'Alfama.');

  const takeout = [
    { header: 'Gemini Apps', title: 'Prompted What is RSS?', time: '2026-03-01T10:00:00Z', safeHtmlItem: [{ html: '<p>A feed &amp; format.</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted And Atom?', time: '2026-03-01T10:10:00Z', safeHtmlItem: [{ html: '<p>Another one.</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted New topic', time: '2026-03-01T15:00:00Z' },
    { header: 'Gemini Apps', title: 'Gave feedback: thumbs up', time: '2026-03-01T15:01:00Z' },
    { header: 'Search', title: 'Searched for cats', time: '2026-03-01T10:05:00Z' },
  ];
  assert.equal(parseExport(takeout).source, 'geminiTakeout');
  const chats = parseGeminiTakeout(takeout);
  assert.equal(chats.length, 2, 'prompts within 30 minutes form one chat');
  assert.deepEqual(chats[0].messages.map((m) => m.content), ['What is RSS?', 'A feed & format.', 'And Atom?', 'Another one.']);
});

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `hist-${name}-`)); }

test('importLocal places chats by folder, adds repos as projects, sends the rest to Misc, and is idempotent', async () => {
  const host = tmp('host');
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = tmp('plain'); // not a repo, no CLAUDE.md → Misc
  const known = tmp('known');
  const settings = { ...defaultSettings(), projects: { hostFolder: host } };
  const proj = await createProject(settings, { name: 'Known', existingPath: known });

  const cc = tmp('cc');
  const write = (dir, name, cwd, text) => {
    fs.mkdirSync(path.join(cc, dir), { recursive: true });
    const f = path.join(cc, dir, `${name}.jsonl`);
    fs.writeFileSync(f, jl(
      { ...base, sessionId: name, cwd, type: 'user', message: { role: 'user', content: text } },
      { ...base, sessionId: name, cwd, type: 'assistant', message: { id: `a-${name}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ));
    const old = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(f, old, old);
    return f;
  };
  write('-repo', 'r1', path.join(repo, '.claude', 'worktrees', 'feature'), 'Work in a worktree');
  write('-known', 'k1', path.join(known, 'src'), 'Known project subfolder');
  write('-plain', 'p1', plain, 'Somewhere else');
  fs.mkdirSync(path.join(cc, '-repo', 'r1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(cc, '-repo', 'r1', 'subagents', 'x.jsonl'), 'not read');
  const live = write('-plain', 'live', plain, 'Still running');
  fs.utimesSync(live, new Date(), new Date());

  // Gemini: projects.json maps the tmp folder name to its project path.
  const gem = tmp('gem');
  fs.mkdirSync(path.join(gem, 'tmp', 'knownname', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(gem, 'projects.json'), JSON.stringify({ projects: { [known]: 'knownname' } }));
  fs.writeFileSync(path.join(gem, 'tmp', 'knownname', 'chats', 'session-1.jsonl'), jl(
    { sessionId: 'a2a-server', projectHash: crypto.createHash('sha256').update(known).digest('hex'), startTime: '2026-10-03T00:00:00Z' },
    { id: 'u', type: 'user', content: [{ text: 'Gemini question' }], timestamp: '2026-10-03T00:00:00Z' },
    { id: 'g', type: 'gemini', content: 'Gemini answer', timestamp: '2026-10-03T00:00:01Z' },
  ));
  fs.writeFileSync(path.join(gem, 'tmp', 'knownname', 'chats', 'session-2.jsonl'), jl(
    { id: 'u', type: 'user', content: [{ text: 'Automated run with no reply' }] },
  ));

  for (const f of ['session-1.jsonl', 'session-2.jsonl']) {
    const old = new Date('2026-10-03T00:00:00Z');
    fs.utimesSync(path.join(gem, 'tmp', 'knownname', 'chats', f), old, old);
  }
  settings.history = { ...settings.history, claudeCodeDir: cc, geminiDir: path.join(gem, 'tmp') };
  const r = await importLocal(settings);
  assert.equal(r.added, 4, JSON.stringify(r));
  assert.equal(r.active, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.misc, 1);
  assert.equal(r.byProject.Known, 2);
  assert.ok(r.newProjects.includes(path.basename(repo)));

  const list = await store.listConversations();
  const byTitle = Object.fromEntries(list.map((c) => [c.title, c]));
  assert.equal(byTitle['Known project subfolder'].projectId, proj.id);
  assert.equal(byTitle['Gemini question'].projectId, proj.id);
  assert.equal(byTitle['Somewhere else'].projectId, null);
  assert.equal(byTitle['Work in a worktree'].updatedAt, '2026-10-01T10:00:00.000Z', 'keeps the original date');
  const wt = await store.getConversation(byTitle['Work in a worktree'].id);
  assert.equal(wt.claudeCodeSessionId, 'r1', 'can be resumed with Claude Code');
  assert.equal(wt.cwd, path.join(repo, '.claude', 'worktrees', 'feature'));
  assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'adding a folder as a project writes nothing into it');

  // The user moves a chat; a forced re-import keeps it there and duplicates nothing.
  const misc = await store.getConversation(byTitle['Somewhere else'].id);
  misc.projectId = proj.id; misc.projectMoved = true;
  await store.saveConversation(misc);
  const again = await importLocal(settings, { force: true });
  assert.equal(again.added, 0);
  assert.equal((await store.getConversation(misc.id)).projectId, proj.id);
  const second = await importLocal(settings);
  assert.equal(second.added + second.updated, 0);
  assert.equal((await store.listConversations()).length, list.length);
});

test('importExport matches web chats to a project by name, else Misc', async () => {
  const host = tmp('host2');
  const settings = { ...defaultSettings(), projects: { hostFolder: host } };
  await createProject(settings, { name: 'Bathroom remodel' });
  const r = await importExport(settings, { content: JSON.stringify([
    { uuid: 'x1', name: 'Tiles for the bathroom remodel', chat_messages: [{ sender: 'human', text: 'Which tiles?' }, { sender: 'assistant', text: 'Porcelain.' }] },
    { uuid: 'x2', name: 'Poem', chat_messages: [{ sender: 'human', text: 'Write a poem' }, { sender: 'assistant', text: 'Roses…' }] },
  ]) });
  assert.equal(r.byProject['Bathroom remodel'], 1);
  assert.equal(r.misc, 1);
  const bad = await importExport(settings, { content: '{"hello":1}' });
  assert.match(bad.errors[0], /not a claude\.ai or Gemini export/);
});

test('projectRootFor never treats the home folder as a project', async () => {
  assert.equal(await projectRootFor(os.homedir()), null);
  assert.equal(await projectRootFor('/'), null);
});

test('skips the harness helper calls and sessions that already are harness chats', async () => {
  const host = tmp('host3');
  const settings = { ...defaultSettings(), projects: { hostFolder: host } };
  const cc = tmp('cc3');
  fs.mkdirSync(path.join(cc, '-x'));
  const put = (name, text) => {
    const f = path.join(cc, '-x', `${name}.jsonl`);
    fs.writeFileSync(f, jl(
      { ...base, sessionId: name, cwd: '/nowhere', type: 'user', message: { role: 'user', content: text } },
      { ...base, sessionId: name, cwd: '/nowhere', type: 'assistant', message: { id: `a-${name}`, role: 'assistant', content: [{ type: 'text', text: '{}' }] } },
    ));
    fs.utimesSync(f, new Date('2026-10-01'), new Date('2026-10-01'));
  };
  put('helper', "You route a user's message to the right model size and check whether it fits");
  put('mine', 'A chat started in the harness');
  const own = await store.createConversation({ provider: 'claudeCode' });
  own.claudeCodeSessionId = 'mine';
  await store.saveConversation(own);
  settings.history = { ...settings.history, claudeCodeDir: cc, geminiDir: tmp('nogem') };
  const r = await importLocal(settings);
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 2);
});
