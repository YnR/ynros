// Settings → Past chats: import Claude Code / Gemini CLI history and claude.ai / Gemini exports.
const $ = (s) => document.querySelector(s);
let ctx;

function describe(r) {
  if (r.error) return r.error;
  const parts = [];
  const changed = r.added + r.updated;
  parts.push(changed ? `Imported ${r.added} new chat${r.added === 1 ? '' : 's'}${r.updated ? ` and updated ${r.updated}` : ''}.` : 'No new chats.');
  const places = Object.entries(r.byProject || {}).map(([name, n]) => `${name} ${n}`);
  if (r.misc) places.push(`Misc ${r.misc}`);
  if (places.length) parts.push(`Placed in: ${places.join(', ')}.`);
  if (r.newProjects?.length) parts.push(`New projects: ${[...new Set(r.newProjects)].join(', ')}.`);
  if (r.unchanged) parts.push(`${r.unchanged} already up to date.`);
  if (r.skipped) parts.push(`${r.skipped} skipped (empty or never answered).`);
  if (r.active) parts.push(`${r.active} still in use, will import next time.`);
  if (r.errors?.length) parts.push(`Problems: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? '…' : ''}`);
  return parts.join(' ');
}

async function run(label, fn) {
  const out = $('#history-report');
  out.textContent = `${label}…`;
  try {
    const r = await fn();
    out.textContent = describe(r);
    ctx.refreshList();
  } catch (e) { out.textContent = e.message; }
}

async function showLocal() {
  try {
    const s = await ctx.api('/api/history/sources');
    const found = [s.claudeCode.found && 'Claude Code', s.geminiCli.found && 'Gemini CLI'].filter(Boolean);
    $('#history-local').textContent = found.length ? `Found ${found.join(' and ')} history.` : 'No Claude Code or Gemini CLI history found here.';
    if (s.last && !$('#history-report').textContent) $('#history-report').textContent = `Last import ${new Date(s.last.at).toLocaleString()}: ${describe(s.last)}`;
  } catch { /* settings view still works */ }
}

export function initHistory(c) {
  ctx = c;
  $('#history-import').addEventListener('click', () => run('Importing', () => ctx.api('/api/history/import', { method: 'POST', body: {} })));
  $('#history-import-path').addEventListener('click', () => {
    const p = $('#history-path').value.trim();
    if (p) run('Importing', () => ctx.api('/api/history/import-file', { method: 'POST', body: { path: p } }));
  });
  $('#history-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await run(`Reading ${file.name}`, async () => ctx.api('/api/history/import-file', { method: 'POST', body: { content: await file.text() } }));
    e.target.value = '';
  });
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#/settings')) showLocal(); });
  if (location.hash.startsWith('#/settings')) showLocal();
}
