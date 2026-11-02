// @-mentions in the composer: autocomplete while typing "@", and a file picker
// (📎 button or "Browse files…") for mouse users.
const $ = (s) => document.querySelector(s);
let ctx;
let items = [];
let sel = 0;
let anchor = -1; // index of the "@" being completed
let reqSeq = 0;

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

function insert(path, { replaceFrom = anchor } = {}) {
  const input = $('#input');
  const v = input.value;
  const caret = input.selectionStart;
  const token = `@${quote(path)} `;
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
  input.dispatchEvent(new Event('input'));
  close();
}

function close() {
  $('#mention-pop').hidden = true;
  anchor = -1;
  items = [];
}

function render() {
  const pop = $('#mention-pop');
  const opts = items.map((f, i) => {
    const o = el('div', `mention-opt${i === sel ? ' sel' : ''}`);
    o.setAttribute('role', 'option');
    o.append(el('span', null, f.dir ? '📁' : '📄'), el('span', null, f.path + (f.dir ? '/' : '')));
    o.addEventListener('mousedown', (e) => { e.preventDefault(); insert(f.path); });
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
    const n = items.length + 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % n; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + n) % n; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (sel === items.length) openPicker(); else if (items[sel]) insert(items[sel].path);
    } else if (e.key === 'Escape') { close(); }
  }, true);
  $('#attach').addEventListener('click', () => { anchor = -1; openPicker(); });
}
