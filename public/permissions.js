// Settings → Permissions: always-allow rules per project, suggestions from past asks,
// "why isn't this folder a project", and the desktop app card.
const $ = (s) => document.querySelector(s);
let ctx;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const scopeName = (scope) => (scope === '*' ? 'Chats outside projects' : ctx.projects().find((p) => p.id === scope)?.name || scope);

async function loadRules() {
  const box = $('#perm-rules');
  try {
    const rules = await ctx.api('/api/permissions/rules');
    const rows = [];
    for (const [scope, list] of Object.entries(rules)) {
      for (const rule of list) {
        const row = el('div', 'perm-row');
        const rm = el('button', 'btn ghost small danger', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', async () => { await ctx.api('/api/permissions/rules', { method: 'POST', body: { scope, rule, remove: true } }); load(); });
        row.append(el('code', null, rule), el('span', 'muted small', scopeName(scope)), rm);
        rows.push(row);
      }
    }
    box.replaceChildren(...(rows.length ? rows : [el('p', 'muted small', 'No rules yet.')]));
  } catch (e) { box.replaceChildren(el('p', 'muted small', e.message)); }
}

async function loadSuggestions() {
  const box = $('#perm-suggestions');
  try {
    const list = await ctx.api('/api/permissions/suggestions');
    box.replaceChildren(...(list.length ? list.slice(0, 30).map((s) => {
      const row = el('div', 'perm-row');
      const add = el('button', 'btn small', 'Always allow');
      add.type = 'button';
      add.addEventListener('click', async () => { await ctx.api('/api/permissions/rules', { method: 'POST', body: { scope: s.scope, rule: s.rule } }); load(); });
      const info = el('span', 'muted small', `${scopeName(s.scope)} · asked ${s.count}×${s.allowed ? `, allowed ${s.allowed}×` : ''}`);
      info.title = s.example || '';
      row.append(el('code', null, s.rule), info, add);
      return row;
    }) : [el('p', 'muted small', 'Nothing to suggest yet.')]));
  } catch (e) { box.replaceChildren(el('p', 'muted small', e.message)); }
}

function fillScopes() {
  const sel = $('#perm-scope');
  sel.replaceChildren(new Option('Chats outside projects', '*'), ...ctx.projects().map((p) => new Option(p.name, p.id)));
}

function load() { fillScopes(); loadRules(); loadSuggestions(); }

export function initPermissions(c) {
  ctx = c;
  $('#perm-add').addEventListener('click', async () => {
    const rule = $('#perm-rule').value.trim();
    if (!rule) return;
    try {
      await ctx.api('/api/permissions/rules', { method: 'POST', body: { scope: $('#perm-scope').value, rule } });
      $('#perm-rule').value = '';
      load();
    } catch (e) { alert(e.message); }
  });
  $('#why-check').addEventListener('click', async () => {
    const p = $('#why-path').value.trim();
    if (!p) return;
    try {
      const r = await ctx.api(`/api/projects/why?path=${encodeURIComponent(p)}`);
      $('#why-result').textContent = `${r.listed ? '✓ Listed. ' : '✗ Not listed. '}${r.reasons.join(' ')}`;
    } catch (e) { $('#why-result').textContent = e.message; }
  });
  const desk = window.harnessDesktop;
  if (desk) {
    $('#desktop-card').hidden = false;
    desk.version?.().then((v) => { $('#app-version').textContent = v ? `Version ${v}` : ''; }).catch(() => {});
    $('#restart-idle').addEventListener('click', async () => {
      $('#app-version').textContent = 'Restarting once no chat is running…';
      desk.restartWhenIdle?.();
    });
  }
  const show = () => { if (location.hash.startsWith('#/settings')) load(); };
  window.addEventListener('hashchange', show);
  show();
}
