// Markdown files: a list of the project's Markdown files, a rendered viewer,
// and a WYSIWYG editor (Toast UI, bundled into /vendor by `npm run build`).
import { renderMarkdown } from './markdown.js';

const $ = (s) => document.querySelector(s);
let ctx;
let files = [];
let current = null; // { path, content, mtime }
let editor = null;
let mode = 'view';
let dirty = false;
let editorLoading = null;

function loadEditorLib() {
  if (window.ToastEditor) return Promise.resolve();
  editorLoading ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/editor.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/vendor/editor.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Editor files are missing. Run "npm run build".'));
    document.head.append(s);
  });
  return editorLoading;
}

function setDirty(v) {
  dirty = v;
  $('#file-state').textContent = v ? 'Unsaved changes' : '';
  $('#file-save').disabled = !v;
}

function renderList() {
  const q = $('#file-filter').value.toLowerCase();
  const nav = $('#file-items');
  nav.replaceChildren(...files.filter((f) => f.path.toLowerCase().includes(q)).map((f) => {
    const a = ctx.el('a', `file-item${current?.path === f.path ? ' active' : ''}`);
    a.href = `#/files/${encodeURIComponent(f.path)}`;
    const parts = f.path.split(/[\\/]/);
    a.append(ctx.el('span', null, parts.pop()));
    if (parts.length) a.append(ctx.el('small', 'muted', parts.join('/')));
    return a;
  }));
  if (!files.length) nav.append(ctx.el('p', 'muted small', 'No Markdown files in this folder yet.'));
}

export async function refreshFiles() {
  try {
    const r = await ctx.api(`/api/files${projectQuery()}`);
    files = r.files;
    $('#file-root').textContent = r.root + (r.truncated ? ' (first 2000 files)' : '');
  } catch (e) {
    files = [];
    $('#file-root').textContent = e.message;
  }
  renderList();
}

function projectQuery(prefix = '?') {
  const p = window.harnessState?.projectId;
  return p ? `${prefix}project=${encodeURIComponent(p)}` : '';
}

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll('#file-mode button')) b.classList.toggle('on', b.dataset.mode === m);
  $('#file-viewer').hidden = m !== 'view';
  $('#file-editor').hidden = m !== 'edit';
  $('#file-save').hidden = m !== 'edit';
  if (m === 'view') {
    const text = editor ? editor.getMarkdown() : current?.content || '';
    $('#file-viewer').innerHTML = renderMarkdown(text);
  } else {
    openEditor();
  }
}

async function openEditor() {
  try { await loadEditorLib(); } catch (e) { $('#file-state').textContent = e.message; return; }
  if (editor) return;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  editor = new window.ToastEditor({
    el: $('#file-editor'),
    height: '100%',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    hideModeSwitch: false,
    usageStatistics: false,
    theme: dark ? 'dark' : undefined,
    initialValue: current?.content || '',
    events: { change: () => setDirty(editor.getMarkdown() !== current?.content) },
  });
}

async function openFile(path) {
  if (dirty && !confirm('Discard unsaved changes?')) { history.back(); return; }
  try {
    current = await ctx.api(`/api/files/content?path=${encodeURIComponent(path)}${projectQuery('&')}`);
  } catch (e) {
    $('#file-state').textContent = e.message;
    return;
  }
  if (editor) { editor.destroy(); editor = null; $('#file-editor').replaceChildren(); }
  setDirty(false);
  $('#file-title').textContent = current.path;
  $('#file-empty').hidden = true;
  $('#file-mode').hidden = false;
  setMode(mode);
  renderList();
}

async function save() {
  if (!current || !editor) return;
  const content = editor.getMarkdown();
  try {
    const r = await ctx.api(`/api/files/content${projectQuery()}`, {
      method: 'PUT', body: { path: current.path, content, expectedMtime: current.mtime },
    });
    current = { ...current, content, mtime: r.mtime };
    setDirty(false);
    $('#file-state').textContent = 'Saved';
  } catch (e) {
    $('#file-state').textContent = e.message;
  }
}

export function showFiles(hash) {
  const m = hash.match(/^#\/files\/(.+)$/);
  refreshFiles();
  if (m) openFile(decodeURIComponent(m[1]));
}

export function initFiles(c) {
  ctx = c;
  $('#file-filter').addEventListener('input', renderList);
  $('#file-refresh').addEventListener('click', refreshFiles);
  $('#file-save').addEventListener('click', save);
  $('#file-new').addEventListener('click', async () => {
    const name = prompt('New file name (inside the folder)', 'notes.md');
    if (!name) return;
    const path = /\.(md|markdown|mdx|txt)$/i.test(name) ? name : `${name}.md`;
    try {
      await ctx.api(`/api/files/content${projectQuery()}`, { method: 'PUT', body: { path, content: `# ${path.replace(/\.\w+$/, '')}\n` } });
      await refreshFiles();
      mode = 'edit';
      location.hash = `#/files/${encodeURIComponent(path)}`;
    } catch (e) { alert(e.message); }
  });
  for (const b of document.querySelectorAll('#file-mode button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && !$('#files-view').hidden) { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
}
