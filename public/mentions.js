// @-mentions in the composer: autocomplete while typing "@", and a file picker
// (📎 button or "Browse files…") for mouse users.
const $ = (s) => document.querySelector(s);
let ctx;
let items = [];
let sel = 0;
let anchor = -1; // index of the "@" being completed
let reqSeq = 0;
let mode = 'file'; // 'file' (@) or 'slash' (/ skills and commands)
let commands = null; // cached /api/skills for the current chat
let commandsKey = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

function query() {
  const conv = ctx.current();
  const project = ctx.projectId();
  if (conv?.id) return `conversation=${encodeURIComponent(conv.id)}`;
  return project ? `project=${encodeURIComponent(project)}` : '';
}

async function search(q, limit = 12) {
  return ctx.api(`/api/mentions?${query()}&q=${encodeURIComponent(q)}&limit=${limit}`);
}

function insert(path, { replaceFrom = anchor, prefix = '@', keepOpen = false } = {}) {
  const input = $('#input');
  const v = input.value;
  const caret = input.selectionStart;
  // A folder outside the project keeps the menu open to browse into it.
  const token = keepOpen ? `${prefix}${path}` : `${prefix}${prefix === '@' ? quote(path) : path} `;
  let next;
  let pos;
  if (replaceFrom >= 0) {
    next = v.slice(0, replaceFrom) + token + v.slice(caret);
    pos = replaceFrom + token.length;
  } else {
    const before = v.slice(0, caret);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    next = before + pad + token + v.slice(caret);
    pos = before.length + pad.length + token.length;
  }
  input.value = next;
  input.focus();
  input.setSelectionRange(pos, pos);
  if (keepOpen) { input.dispatchEvent(new Event('input')); return; }
  input.dispatchEvent(new Event('input'));
  close();
}

function close() {
  $('#mention-pop').hidden = true;
  anchor = -1;
  items = [];
}

function choose(i) {
  const f = items[i];
  if (!f) return;
  if (mode === 'slash') insert(f.name, { prefix: '/' });
  else insert(f.path, { keepOpen: Boolean(f.dir && /^(~|\/)/.test(f.path)) });
}

function render() {
  const pop = $('#mention-pop');
  if (mode === 'slash') {
    const opts = items.map((c, i) => {
      const o = el('div', `mention-opt${i === sel ? ' sel' : ''}`);
      o.setAttribute('role', 'option');
      o.append(el('span', null, c.kind === 'skill' ? '✦' : '/'), el('b', null, c.name), el('span', 'muted', ` ${c.scope}${c.description ? ` · ${c.description}` : ''}`));
      o.title = c.description || '';
      o.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; choose(i); });
      return o;
    });
    if (!items.length) opts.push(el('div', 'mention-opt muted', 'No matching skills or commands'));
    pop.replaceChildren(...opts);
    pop.hidden = false;
    return;
  }
  const opts = items.map((f, i) => {
    const o = el('div', `mention-opt${i === sel ? ' sel' : ''}`);
    o.setAttribute('role', 'option');
    o.append(el('span', null, f.dir ? '📁' : '📄'), el('span', null, f.path + (f.dir && !f.path.endsWith('/') ? '/' : '')));
    o.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; choose(i); });
    return o;
  });
  const browse = el('div', `mention-opt browse${sel === items.length ? ' sel' : ''}`, 'Browse files…');
  browse.addEventListener('mousedown', (e) => { e.preventDefault(); openPicker(); });
  if (!items.length) opts.push(el('div', 'mention-opt muted', 'No matching files'));
  pop.replaceChildren(...opts, browse);
  pop.hidden = false;
}

async function update() {
  const input = $('#input');
  const before = input.value.slice(0, input.selectionStart);
  // "/" anywhere after a space (not only at the start) opens skills and commands.
  const s = before.match(/(^|\s)\/([\w:.-]*)$/);
  if (s) {
    mode = 'slash';
    anchor = before.length - s[2].length - 1;
    const conv = ctx.current();
    const key = query();
    if (!commands || commandsKey !== key) {
      commandsKey = key;
      try { commands = await ctx.api(`/api/skills?${key}`); } catch { commands = []; }
    }
    const q = s[2].toLowerCase();
    items = commands.filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 12);
    void conv;
    sel = 0;
    render();
    return;
  }
  mode = 'file';
  const m = before.match(/(^|\s)@("?)([^\s"]*)$/);
  if (!m) { close(); return; }
  anchor = before.length - m[3].length - m[2].length - 1;
  const seq = ++reqSeq;
  try {
    const r = await search(m[3]);
    if (seq !== reqSeq) return;
    items = r.files;
    sel = 0;
    render();
  } catch { close(); }
}

export async function openPicker() {
  const fromAnchor = anchor;
  close();
  const dlg = $('#picker');
  const filter = $('#picker-filter');
  filter.value = '';
  const list = $('#picker-list');
  const load = async () => {
    try {
      const r = await search(filter.value, 300);
      $('#picker-root').textContent = r.root || 'No folder for this chat. Pick a project or set the Claude Code working directory.';
      list.replaceChildren(...r.files.map((f) => {
        const b = el('button', 'picker-item');
        b.type = 'button';
        b.append(document.createTextNode(`${f.dir ? '📁' : '📄'} ${f.path}${f.dir ? '/' : ''}`));
        b.addEventListener('click', () => { dlg.close(); insert(f.path, { replaceFrom: fromAnchor }); });
        return b;
      }));
      if (!r.files.length) list.append(el('p', 'muted small', 'Nothing matches.'));
    } catch (e) { list.replaceChildren(el('p', 'muted small', e.message)); }
  };
  filter.oninput = () => { clearTimeout(filter._t); filter._t = setTimeout(load, 150); };
  await load();
  dlg.showModal();
  filter.focus();
}

export function initMentions(c) {
  ctx = c;
  const input = $('#input');
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if ($('#mention-pop').hidden) return;
    const n = items.length + (mode === 'slash' ? 0 : 1);
    if (!n) { if (e.key === 'Escape') close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + 1) % n; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel - 1 + n) % n; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (mode === 'file' && sel === items.length) openPicker(); else choose(sel);
    } else if (e.key === 'Escape') { close(); }
  }, true);
}
