import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../server/triage.js';
import { isSafeGit, ruleFor, addRule, readRules } from '../server/approvals.js';
import { activeMessages, transcriptPrefix, contextLimit } from '../server/convo.js';
import { toApiMessages } from '../server/providers/anthropic.js';
import { toContents } from '../server/providers/gemini.js';
import { friendlyError } from '../server/runs.js';
import { listCommands } from '../server/integrations/skills.js';
import { defaultSettings } from '../server/settings.js';

test('triage recommends one of four options', () => {
  assert.equal(parseVerdict('{"decision":"parallel","reason":"separate"}').decision, 'parallel');
  assert.equal(parseVerdict('{"decision":"new","reason":"unrelated"}').decision, 'new');
  assert.equal(parseVerdict('{"decision":"interrupt"}').decision, 'interrupt');
  assert.equal(parseVerdict('nonsense').decision, 'queue');
});

test('safe git commands pass; destructive ones and compound tricks do not', () => {
  for (const c of ['git status', 'git diff --stat', 'git log -5', 'git add -A && git commit -m "x"', 'git checkout -b feat', 'git fetch origin main']) assert.ok(isSafeGit(c), c);
  for (const c of ['git push', 'git reset --hard', 'git branch -D x', 'git status && rm -rf /', 'git clean -fd', 'git rebase main', 'git push --force']) assert.ok(!isSafeGit(c), c);
});

test('always-allow rules are scoped and checked per command part', async () => {
  assert.equal(ruleFor('Bash', { command: 'npm run build -- --prod' }), 'Bash(npm run:*)');
  assert.equal(ruleFor('Bash', { command: 'ls -la' }), 'Bash(ls:*)');
  assert.equal(ruleFor('WebFetch', { url: 'https://x' }), 'WebFetch');
  await addRule('p1', 'Bash(npm run:*)');
  assert.deepEqual((await readRules()).p1, ['Bash(npm run:*)']);
});

test('/clear hides earlier turns from the model; branches carry context in the prompt', () => {
  const msgs = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'system', kind: 'clear' },
    { role: 'user', content: 'c' },
  ];
  assert.deepEqual(activeMessages(msgs).map((m) => m.content), ['c']);
  const p = transcriptPrefix([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'next' }]);
  assert.match(p, /User: first/);
  assert.match(p, /Assistant: reply/);
  assert.doesNotMatch(p, /next/);
  assert.equal(contextLimit('anthropic', 'claude-opus-5-5[1m]'), 1_000_000);
});

test('pasted images reach the API models', () => {
  const img = { mime: 'image/png', data: 'AAAA' };
  const a = toApiMessages([{ role: 'user', content: 'look', imageData: [img] }]);
  assert.equal(a[0].content[0].type, 'image');
  assert.equal(a[0].content[1].text, 'look');
  assert.equal(toApiMessages([{ role: 'user', content: 'plain' }])[0].content, 'plain');
  const g = toContents([{ role: 'user', content: 'look', imageData: [img] }]);
  assert.equal(g[0].parts[0].inlineData.mimeType, 'image/png');
});

test('model-access errors explain what to do', () => {
  assert.match(friendlyError('API Error: 401 Team not allowed to access model', 'claudeCode', 'opus'), /can't use the model "opus"/);
});

test('the / menu always offers /clear', async () => {
  const list = await listCommands(defaultSettings(), null);
  assert.ok(list.some((c) => c.name === 'clear'));
});

test('local Claude Code: PATH merge, binary lookup, and no API key leaks into the CLI', async () => {
  const { mergePath, findOnPath, resolveClaudeBinary } = await import('../server/shellEnv.js');
  const { childEnv } = await import('../server/providers/claudeCode.js');
  assert.equal(mergePath('/a:/b', '/b:/c', ''), '/a:/b:/c');
  assert.equal(findOnPath('definitely-not-here-xyz', '/usr/bin:/bin'), null);
  assert.ok(findOnPath('sh', '/usr/bin:/bin'));
  assert.equal(resolveClaudeBinary('/opt/x/claude'), '/opt/x/claude');
  const env = childEnv({}, { PATH: '/x', ANTHROPIC_API_KEY: 'k' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/x');
  assert.equal(childEnv({ useApiKey: true }, { ANTHROPIC_API_KEY: 'k' }).ANTHROPIC_API_KEY, 'k');
});

test('settings sections added later are saved, not dropped', async () => {
  const { updateSettings, loadSettings } = await import('../server/settings.js');
  await updateSettings({ desktop: { openAtLogin: true }, briefing: { hour: 7 }, migrations: { localClaudeCode: true } });
  const s = await loadSettings();
  assert.equal(s.desktop.openAtLogin, true);
  assert.equal(s.briefing.hour, 7);
  assert.equal(s.migrations.localClaudeCode, true);
  assert.equal(defaultSettings().defaultProvider, 'claudeCode');
});

test('fuzzy search: substrings, letters in order, typos of omission; Claude picks are validated', async () => {
  const { fuzzyScore, fuzzyRank } = await import('../public/fuzzy.js');
  assert.ok(fuzzyScore('notif', 'Notifications'));
  assert.ok(fuzzyScore('ntfctn', 'Notifications'));
  assert.ok(fuzzyScore('chats per', 'Chats shown per project'));
  assert.equal(fuzzyScore('zebra', 'Notifications'), 0);
  assert.equal(fuzzyScore('ae', 'a' + 'x'.repeat(100) + 'e'), 0, 'letters spread too far apart do not match');
  const r = fuzzyRank('lisbon', [{ t: 'Trip to Lisbon' }, { t: 'Lunch' }, { t: 'lisbon flights' }], (x) => [[x.t]]);
  assert.deepEqual(r.map((x) => x.item.t), ['lisbon flights', 'Trip to Lisbon']);
  const { parseMatches, snippet } = await import('../server/search.js');
  assert.deepEqual(parseMatches('{"matches":[{"n":2,"why":"x"},{"n":2},{"n":9},{"n":"a"}]}', 3).matches, [{ n: 2, why: 'x' }]);
  assert.match(snippet('a '.repeat(100) + 'the tile quote arrived', 'tile'), /^…/);
});

test('smaller-model hint: knows model sizes and only suggests going down', async () => {
  const { tierOfModel, smallerSuggestion } = await import('../server/router.js');
  const s = defaultSettings();
  assert.equal(tierOfModel(s, 'claudeCode', 'opus'), 'large');
  assert.equal(tierOfModel(s, 'claudeCode', 'sonnet'), 'medium');
  assert.equal(tierOfModel(s, 'anthropic', 'claude-opus-5-5'), 'large');
  assert.equal(tierOfModel(s, 'gemini', 'gemini-2.5-flash-lite'), 'small');
  assert.equal(tierOfModel(s, 'claudeCode', 'my-custom'), null);
  assert.deepEqual(smallerSuggestion(s, 'claudeCode', 'large', 'small', 'quick fact'), { tier: 'small', model: 'haiku', from: 'large', reason: 'quick fact' });
  assert.equal(smallerSuggestion(s, 'claudeCode', 'small', 'large'), null);
  assert.equal(smallerSuggestion(s, 'claudeCode', 'medium', 'medium'), null);
});
