import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as b from '../server/briefing.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const settings = { briefing: { dir } };

const mail = (id, subject) => ({ id, threadId: id, from: 'Kim <kim@contractor.test>', subject, date: '2026-11-02T10:00:00Z', snippet: 'Quote attached' });

test('sections always include bathroom remodel, job search and other', () => {
  const s = b.normalizeSections([{ title: 'Team Q4 planning', description: 'x' }, { title: 'Team Q4 planning' }]);
  assert.deepEqual(s.map((x) => x.id), ['team-q4-planning', 'bathroom-remodel', 'job-search', 'other']);
});

test('model replies fold into a day; open actions carry forward, done ones do not', () => {
  const sections = b.normalizeSections([]);
  const day = b.emptyDay('2026-11-02', sections);
  const refs = b.refsFor({ mail: [mail('t1', 'Tile quote')], events: [], sent: [] });
  b.applyModel(day, {
    summary: 'Tile quote arrived.',
    sections: [{ id: 'bathroom-remodel', items: [{ ref: 'm1', headline: 'Tile quote from Kim', detail: '$4k' }] }, { id: 'nope', items: [{ ref: 'zz', headline: 'stray' }] }],
    actions: { new: [{ text: 'Reply to Kim about tile', section: 'bathroom-remodel', ref: 'm1' }, { text: 'Update resume', section: 'job-search' }] },
  }, refs, sections);
  const bath = day.sections.find((s) => s.id === 'bathroom-remodel');
  assert.equal(bath.items[0].link, 'https://mail.google.com/mail/u/0/#all/t1');
  assert.equal(day.sections.find((s) => s.id === 'other').items[0].headline, 'stray');
  assert.equal(day.actions.length, 2);
  // Same item again is not duplicated.
  b.applyModel(day, { sections: [{ id: 'bathroom-remodel', items: [{ ref: 'm1', headline: 'again' }] }], actions: { new: [{ text: 'reply to kim about tile' }] } }, refs, sections);
  assert.equal(bath.items.length, 1);
  assert.equal(day.actions.length, 2);
  day.actions[1].status = 'done';
  const next = b.carryForward(day, '2026-11-03', sections);
  assert.deepEqual(next.actions.map((a) => a.text), ['Reply to Kim about tile']);
  assert.equal(next.actions[0].id, day.actions[0].id);
});

test('ensure starts today, backfills missing days from fresh calls, and builds on the last day', async () => {
  const calls = [];
  const deps = {
    gatherWeek: async () => ({ mail: [mail('w1', 'PTA meeting')], sent: [], events: [] }),
    gather: async (_s, key) => { calls.push(key); return { connected: true, mail: [mail(`t-${key}`, `Mail ${key}`)], sent: [], events: [], errors: [] }; },
    ask: async (_s, _p, system, content) => {
      if (/propose 3 to 6 sections/.test(system)) return '{"sections":[{"title":"Family","description":"kids and school"}]}';
      const open = [...content.matchAll(/- \[(a_[0-9a-f]+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ summary: 'ok', sections: [{ id: 'other', items: [{ ref: 'm1', headline: 'h' }] }], actions: { new: [{ text: `Do ${calls.at(-1)}`, section: 'family' }], done: open.slice(0, 1) } });
    },
  };
  let r = await b.ensure(settings, {}, { deps, today: '2026-11-02' });
  assert.deepEqual(r.built, ['2026-11-02']);
  const cfg = await b.readConfig(settings);
  assert.equal(cfg.startDate, '2026-11-02');
  assert.deepEqual(cfg.sections.map((s) => s.id), ['family', 'bathroom-remodel', 'job-search', 'other']);
  assert.ok(fs.existsSync(path.join(dir, '2026-11-02.html')));

  // Two days later: 11-03 is backfilled, 11-04 is built, each from the day before.
  r = await b.ensure(settings, {}, { deps, today: '2026-11-04' });
  assert.deepEqual(r.built, ['2026-11-03', '2026-11-04']);
  const d3 = await b.readDay(settings, '2026-11-03');
  assert.equal(d3.backfilled, true);
  assert.equal(d3.actions.find((a) => a.text === 'Do 2026-11-02').status, 'done');
  assert.equal(d3.actions.find((a) => a.text === 'Do 2026-11-02').doneBy, 'briefing');
  const d4 = await b.readDay(settings, '2026-11-04');
  assert.ok(!d4.actions.some((a) => a.text === 'Do 2026-11-02'), 'done items stay behind');
  assert.ok(d4.actions.some((a) => a.text === 'Do 2026-11-04'));

  // Nothing missing: no new calls unless refreshing.
  calls.length = 0;
  r = await b.ensure(settings, {}, { deps, today: '2026-11-04' });
  assert.deepEqual(r.built, []);
  assert.deepEqual(calls, []);
  await b.ensure(settings, {}, { deps, today: '2026-11-04', refresh: true });
  assert.deepEqual(calls, ['2026-11-04']);
});

test('your edits on a day carry to later days; the briefing does not undo them', async () => {
  const d3 = await b.readDay(settings, '2026-11-03');
  const open = d3.actions.find((a) => a.status === 'open');
  await b.updateAction(settings, '2026-11-03', open.id, { note: 'Called them' });
  await b.updateAction(settings, '2026-11-03', open.id, { status: 'done' });
  const d4 = await b.readDay(settings, '2026-11-04');
  const later = d4.actions.find((a) => a.id === open.id);
  assert.equal(later.status, 'done');
  assert.equal(later.notes.at(-1).text, 'Called them');
  const added = await b.addAction(settings, '2026-11-03', { text: 'Book plumber', section: 'bathroom-remodel' });
  assert.ok((await b.readDay(settings, '2026-11-04')).actions.some((a) => a.id === added.id));
  // Reopened by you: the model's "done" is ignored.
  await b.updateAction(settings, '2026-11-04', added.id, { status: 'open' });
  const d = await b.readDay(settings, '2026-11-04');
  b.applyModel(d, { actions: { done: [added.id] } }, {}, b.normalizeSections([]));
  assert.equal(d.actions.find((a) => a.id === added.id).status, 'open');
});

test('the HTML copy escapes mail text and only links https', () => {
  const html = b.renderHtml({ date: '2026-11-02', summary: '<script>x</script>', actions: [], sections: [{ id: 'other', title: 'Other', items: [{ headline: '<b>hi</b>', link: 'javascript:alert(1)' }] }] });
  assert.ok(!html.includes('<script>x'));
  assert.ok(!html.includes('javascript:'));
});
