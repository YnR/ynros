import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ics from '../server/integrations/ics.js';
import * as gemini from '../server/providers/gemini.js';
import * as anthropic from '../server/providers/anthropic.js';
import { defaultSettings } from '../server/settings.js';
import { parseVerdict, buildTriagePrompt, pickTriageModel } from '../server/triage.js';

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:1
SUMMARY:Standup\\, daily
DTSTART:20261102T090000Z
DTEND:20261102T091500Z
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5
EXDATE:20261104T090000Z
END:VEVENT
BEGIN:VEVENT
UID:2
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106
END:VEVENT
BEGIN:VEVENT
UID:3
SUMMARY:Cancelled
STATUS:CANCELLED
DTSTART:20261103T100000Z
END:VEVENT
END:VCALENDAR`;

test('ics: parses, expands weekly BYDAY rules, honours EXDATE and COUNT', () => {
  const events = ics.expand(ics.parseIcs(ICS), new Date('2026-11-01T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
  const standups = events.filter((e) => e.uid === '1').map((e) => e.start.toISOString().slice(0, 10));
  assert.deepEqual(standups, ['2026-11-02', '2026-11-06', '2026-11-09', '2026-11-11']); // 5 occurrences minus the EXDATE
  assert.equal(events.find((e) => e.uid === '1').summary, 'Standup, daily');
  assert.ok(events.find((e) => e.uid === '2').allDay);
  assert.ok(!events.some((e) => e.uid === '3'));
});

test('ics: feed list accepts names, comments and webcal://', () => {
  const feeds = ics.parseFeeds('# work\nWork | webcal://example.com/a.ics\nhttps://cal.example.org/b.ics\n');
  assert.deepEqual(feeds, [
    { id: 'ics:1', name: 'Work', url: 'https://example.com/a.ics' },
    { id: 'ics:2', name: 'cal.example.org', url: 'https://cal.example.org/b.ics' },
  ]);
});

function sse(events) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
}

const fakeTool = { name: 'gmail_search', description: 'x', schema: { type: 'object', properties: { query: { type: 'string' } } } };

test('gemini: runs a function call and sends the result back', async () => {
  const settings = defaultSettings();
  settings.gemini.apiKey = 'k';
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return sse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'gmail_search', args: { query: 'is:unread' } }, thoughtSignature: 'sig' }] } }] }]);
    }
    return sse([{ candidates: [{ content: { parts: [{ text: 'You have 1 unread.' }] }, finishReason: 'STOP' }] }]);
  };
  const calls = [];
  const events = [];
  for await (const ev of gemini.stream({
    settings, messages: [{ role: 'user', content: 'unread?' }], fetchImpl,
    tools: [fakeTool], runTool: async (n, a) => { calls.push([n, a]); return { results: [{ subject: 'Hi' }] }; },
  })) events.push(ev);
  assert.deepEqual(calls, [['gmail_search', { query: 'is:unread' }]]);
  assert.equal(bodies[0].tools[0].functionDeclarations[0].name, 'gmail_search');
  const second = bodies[1].contents;
  assert.equal(second.at(-2).parts[0].thoughtSignature, 'sig', 'model parts are sent back verbatim');
  assert.equal(second.at(-1).parts[0].functionResponse.response.results[0].subject, 'Hi');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'gmail_search'));
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), /1 unread/);
});

test('anthropic: runs tool_use blocks and loops until end_turn', async () => {
  const settings = defaultSettings();
  settings.anthropic.apiKey = 'k';
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'load_skill' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"greet"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      ]);
    }
    return sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Salutations.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]);
  };
  const events = [];
  for await (const ev of anthropic.stream({
    settings, messages: [{ role: 'user', content: 'greet' }], fetchImpl,
    tools: [{ name: 'load_skill', description: 'x', schema: { type: 'object', properties: {} } }],
    runTool: async () => ({ name: 'greet', instructions: '# Greet\nSay salutations.', path: '/s/greet' }),
  })) events.push(ev);
  assert.deepEqual(bodies[1].messages.at(-2).content.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(bodies[1].messages.at(-2).content[1].input, { name: 'greet' });
  assert.equal(bodies[1].messages.at(-1).content[0].tool_use_id, 't1');
  const skills = events.filter((e) => e.type === 'skill');
  assert.equal(skills.at(-1).text, '# Greet\nSay salutations.', 'skills surface as skill events, not tool output');
  assert.deepEqual(events.at(-1).usage, { input: 5, output: 5 });
});

test('triage: parses verdicts and prefers a connected small model', () => {
  assert.deepEqual(parseVerdict('```json\n{"decision":"interrupt","reason":"user said stop"}\n```'), { decision: 'interrupt', reason: 'user said stop' });
  assert.equal(parseVerdict('nonsense').decision, 'queue');
  const s = defaultSettings();
  delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
  assert.deepEqual(pickTriageModel(s), { provider: 'claudeCode', model: 'haiku' });
  s.gemini.apiKey = 'g';
  assert.equal(pickTriageModel(s).provider, 'gemini');
  s.anthropic.apiKey = 'a';
  assert.deepEqual(pickTriageModel(s), { provider: 'anthropic', model: 'claude-haiku-5-5' });
  assert.match(buildTriagePrompt({ task: 'T', message: 'M', queued: ['Q'] }), /## New message\nM/);
});

test('mentions: API models get mentioned files inline', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { expandMentions } = await import('../server/files.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mention-'));
  await fs.writeFile(path.join(dir, 'a.md'), 'alpha');
  await fs.writeFile(path.join(dir, 'my notes.txt'), 'beta');
  const r = await expandMentions(dir, 'see @a.md and @"my notes.txt", not @missing.md or me@example.com');
  assert.deepEqual(r.attachments, ['a.md', 'my notes.txt']);
  assert.match(r.content, /<attached_file path="a.md">\nalpha\n<\/attached_file>/);
  assert.match(r.content, /<attached_file path="my notes.txt">\nbeta/);
  const outside = await expandMentions(dir, 'read @../../etc/passwd');
  assert.deepEqual(outside.attachments, []);
  await fs.rm(dir, { recursive: true });
});

test('contacts: vCard parsing, notebook notes, merged search', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'people-'));
  const contacts = await import('../server/integrations/contacts.js');
  const vcf = path.join(dir, 'c.vcf');
  await fs.writeFile(vcf, 'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nEMAIL;TYPE=work:ada@example.com\nTEL:+44 1\nORG:Analytical;Engines\nEND:VCARD\nBEGIN:VCARD\nN:Hopper;Grace;;;\nEMAIL:grace@example.com\nEND:VCARD\n');
  const parsed = contacts.parseVcards(await fs.readFile(vcf, 'utf8'));
  assert.equal(parsed[1].name, 'Grace Hopper');
  assert.equal(parsed[0].organization, 'Analytical, Engines');

  const settings = defaultSettings();
  settings.contacts.vcardSources = vcf;
  await contacts.addNote({ email: 'ada@example.com', name: 'Ada', note: 'Prefers mornings' });
  const r = await contacts.search(settings, 'ada');
  assert.equal(r.results[0].name, 'Ada Lovelace');
  assert.equal(r.results[0].notes[0].text, 'Prefers mornings');
  assert.equal(r.results.length, 1, 'notebook entry merges with the contact');
  await fs.rm(dir, { recursive: true });
});
