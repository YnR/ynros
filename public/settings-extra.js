// Settings pieces beyond plain fields: theme switch, MCP servers and
// marketplaces, quota budgets.
const $ = (s) => document.querySelector(s);
let ctx;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- theme ---------- */

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try { localStorage.setItem('harness-theme', theme || 'system'); } catch { /* ignore */ }
  window.harnessDesktop?.setTheme?.(theme || 'system');
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.classList.toggle('on', b.dataset.themeChoice === (theme || 'system'));
}

export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ---------- MCP ---------- */

function parseKv(text, isUrl) {
  const out = {};
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = isUrl ? line.match(/^([^:]+):\s*(.*)$/) : line.match(/^([^=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function splitCommand(s) {
  const parts = [];
  let cur = '';
  let q = null;
  for (const ch of s.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; } else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { parts.push(cur); cur = ''; } } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

export async function loadMcp() {
  const list = $('#mcp-list');
  try {
    const { servers } = await ctx.api('/api/mcp');
    if (!servers.length) { list.replaceChildren(el('p', 'muted small', 'No MCP servers yet.')); return; }
    list.replaceChildren(...servers.map((s) => {
      const row = el('div', 'mcp-row');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = s.enabled !== false;
      on.title = 'Enabled';
      on.addEventListener('change', () => ctx.api(`/api/mcp/${s.name}/enabled`, { method: 'POST', body: { enabled: on.checked } }));
      const info = el('div');
      info.append(el('b', null, s.name), el('code', 'muted', s.url || [s.command, ...(s.args || [])].join(' ')));
      const src = String(s.source || 'manual').replace(/^claude-plugin:/, 'Claude plugin: ').replace(/^gemini-extension:/, 'Gemini ext: ').replace(/^preset:/, 'preset: ');
      info.append(el('span', 'muted', ` ${src}`));
      const confirmBox = el('label', 'check small');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(s.confirm);
      cb.addEventListener('change', () => ctx.api(`/api/mcp/${s.name}/confirm`, { method: 'POST', body: { confirm: cb.checked } }));
      confirmBox.append(cb, document.createTextNode('Ask first'));
      confirmBox.title = 'Ask me before any action that is not read-only';
      const test = el('button', 'btn small', 'Test');
      test.type = 'button';
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = 'Testing…';
        try {
          const r = await ctx.api(`/api/mcp/${s.name}/tools`);
          test.textContent = r.error ? 'Failed' : `${r.tools.length} tools`;
          test.title = r.error || r.tools.map((t) => t.name).join(', ');
        } catch (e) { test.textContent = 'Failed'; test.title = e.message; }
        test.disabled = false;
      });
      const rm = el('button', 'btn ghost small danger', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove ${s.name}?`)) return;
        await ctx.api(`/api/mcp/${s.name}`, { method: 'DELETE' });
        loadMcp();
      });
      row.append(on, info, confirmBox, test, rm);
      return row;
    }));
  } catch (e) { list.replaceChildren(el('p', 'muted small', e.message)); }
}

let plugins = [];
function renderPlugins() {
  const q = $('#mcp-filter').value.toLowerCase();
  const box = $('#mcp-claude-list');
  const shown = plugins.filter((p) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q)).slice(0, 200);
  box.replaceChildren(...shown.map((p) => {
    const row = el('div', 'plugin');
    row.append(el('b', null, `${p.name} `), el('span', 'muted', `${p.description || ''} · ${p.marketplace}`));
    const b = el('button', `btn small${p.installed ? '' : ' primary'}`, p.installed ? 'Installed' : 'Install');
    b.type = 'button';
    b.disabled = p.installed;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Installing…';
      try {
        const r = await ctx.api('/api/mcp/claude-marketplace/install', { method: 'POST', body: { pluginId: p.id } });
        p.installed = true;
        b.textContent = r.imported.length ? `Installed (+${r.imported.length} MCP)` : 'Installed';
        loadMcp();
      } catch (e) { b.textContent = 'Failed'; b.title = e.message; b.disabled = false; alert(e.message); }
    });
    row.append(b);
    return row;
  }));
  if (!shown.length) box.append(el('p', 'muted small', plugins.length ? 'No plugins match.' : 'Click "Load plugins".'));
}

async function loadPlugins() {
  const b = $('#mcp-claude-load');
  b.disabled = true;
  b.textContent = 'Loading…';
  try {
    const r = await ctx.api('/api/mcp/claude-marketplace');
    plugins = r.available;
    renderPlugins();
    b.textContent = `Reload (${plugins.length})`;
  } catch (e) {
    $('#mcp-claude-list').replaceChildren(el('p', 'muted small', e.message));
    b.textContent = 'Load plugins';
  }
  b.disabled = false;
}

/* ---------- quota ---------- */

export function fillQuota(settings) {
  for (const input of document.querySelectorAll('[data-quota]')) {
    const [p, k] = input.dataset.quota.split('.');
    input.value = settings.quota?.[p]?.[k] ?? '';
  }
  ctx.api('/api/quota').then((q) => {
    const parts = Object.values(q).map((s) => {
      if (s.exhausted) return `${s.label}: out until ${s.resetsAt ? new Date(s.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'reset'}`;
      if (s.utilization != null) return `${s.label}: ${Math.round(s.utilization * 100)}% used`;
      return null;
    }).filter(Boolean);
    $('#quota-summary').textContent = parts.length ? `Now: ${parts.join(' · ')}` : 'No usage reported yet.';
  }).catch(() => {});
}

export function collectQuota(patch) {
  patch.quota ||= {};
  for (const input of document.querySelectorAll('[data-quota]')) {
    const [p, k] = input.dataset.quota.split('.');
    patch.quota[p] ||= {};
    patch.quota[p][k] = Number(input.value) || 0;
  }
}

export function initSettingsExtra(c) {
  ctx = c;
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.addEventListener('click', async () => {
      const theme = b.dataset.themeChoice;
      $('#settings-form').elements['appearance.theme'].value = theme;
      applyTheme(theme);
      await ctx.save({ appearance: { theme } });
    });
  }
  $('#mcp-add').addEventListener('click', async () => {
    const out = $('#mcp-add-result');
    const name = $('#mcp-name').value.trim();
    const target = $('#mcp-target').value.trim();
    const isUrl = /^https?:\/\//i.test(target);
    const kv = parseKv($('#mcp-env').value, isUrl);
    const config = isUrl ? { url: target, headers: kv } : (() => { const [command, ...args] = splitCommand(target); return { command, args, env: kv }; })();
    try {
      await ctx.api('/api/mcp', { method: 'POST', body: { name, config } });
      out.className = 'test-result ok';
      out.textContent = 'Added.';
      $('#mcp-name').value = ''; $('#mcp-target').value = ''; $('#mcp-env').value = '';
      loadMcp();
    } catch (e) { out.className = 'test-result fail'; out.textContent = e.message; }
  });
  $('#mcp-chrome').addEventListener('click', async () => {
    try { await ctx.api('/api/mcp/preset/chrome', { method: 'POST', body: {} }); loadMcp(); } catch (e) { alert(e.message); }
  });
  $('#mcp-claude-load').addEventListener('click', loadPlugins);
  $('#mcp-filter').addEventListener('input', renderPlugins);
  $('#mcp-market-add').addEventListener('click', async () => {
    const source = $('#mcp-market-source').value.trim();
    if (!source) return;
    try {
      await ctx.api('/api/mcp/claude-marketplace/add', { method: 'POST', body: { source } });
      $('#mcp-market-source').value = '';
      loadPlugins();
    } catch (e) { alert(e.message); }
  });
  $('#gemini-ext-add').addEventListener('click', async () => {
    const out = $('#gemini-ext-result');
    try {
      const r = await ctx.api('/api/mcp/gemini-extension', { method: 'POST', body: { url: $('#gemini-ext-url').value } });
      out.className = 'test-result ok';
      out.textContent = `Imported ${r.imported.length} server(s) from ${r.extension}${r.skipped.length ? `; skipped ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}` : ''}.`;
      loadMcp();
    } catch (e) { out.className = 'test-result fail'; out.textContent = e.message; }
  });
}
