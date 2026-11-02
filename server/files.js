import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Read and write Markdown/text files inside one root folder (the Claude Code
 * working directory by default). Paths are always resolved inside the root.
 */
const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);
const MAX_BYTES = 2_000_000;

function err(status, message) { return Object.assign(new Error(message), { status }); }

export async function resolveInside(root, rel = '') {
  if (!root) throw err(400, 'No files folder set. Choose one in Settings.');
  const realRoot = await fs.realpath(root).catch(() => { throw err(400, `Folder not found: ${root}`); });
  const target = path.resolve(realRoot, String(rel).replace(/^[/\\]+/, ''));
  let real = target;
  try { real = await fs.realpath(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(target) || !inside(real)) throw err(403, 'Path is outside the files folder');
  return { root: realRoot, abs: real, rel: path.relative(realRoot, real) };
}

export const isText = (name) => TEXT_EXT.has(path.extname(name).toLowerCase());

/** List Markdown/text files under the root (recursive, capped). */
export async function listFiles(root, { limit = 2000, depth = 6 } = {}) {
  const { root: base } = await resolveInside(root);
  const out = [];
  async function walk(dir, d) {
    if (d > depth || out.length >= limit) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs, d + 1);
      } else if (e.isFile() && isText(e.name)) {
        const st = await fs.stat(abs).catch(() => null);
        out.push({ path: path.relative(base, abs), size: st?.size ?? 0, mtime: st?.mtime?.toISOString() });
      }
    }
  }
  await walk(base, 0);
  return { root: base, files: out, truncated: out.length >= limit };
}

export async function readFile(root, rel) {
  const { abs, rel: r } = await resolveInside(root, rel);
  if (!isText(abs)) throw err(415, 'Only Markdown and text files can be opened');
  const st = await fs.stat(abs).catch(() => { throw err(404, 'File not found'); });
  if (st.size > MAX_BYTES) throw err(413, 'File is too large to open here');
  return { path: r, content: await fs.readFile(abs, 'utf8'), mtime: st.mtime.toISOString() };
}

/** Save a file. If `expectedMtime` is given and the file changed since, refuse (409). */
export async function writeFile(root, rel, content, expectedMtime) {
  const { abs, rel: r } = await resolveInside(root, rel);
  if (!isText(abs)) throw err(415, 'Only Markdown and text files can be saved');
  if (typeof content !== 'string' || content.length > MAX_BYTES) throw err(413, 'Content too large');
  if (expectedMtime) {
    const st = await fs.stat(abs).catch(() => null);
    if (st && st.mtime.toISOString() !== expectedMtime) {
      throw err(409, 'The file changed on disk since you opened it. Reload it before saving.');
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  const st = await fs.stat(abs);
  return { path: r, mtime: st.mtime.toISOString() };
}

/** Every file under the root (any type), for @-mention autocomplete and the file picker. */
export async function listAllFiles(root, { query = '', limit = 200, scanLimit = 20000, depth = 8 } = {}) {
  const { root: base } = await resolveInside(root);
  const q = query.toLowerCase();
  const out = [];
  let scanned = 0;
  async function walk(dir, d) {
    if (d > depth || scanned >= scanLimit) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (scanned >= scanLimit) return;
      scanned++;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!q || rel.toLowerCase().includes(q)) out.push({ path: rel, dir: true });
        await walk(abs, d + 1);
      } else if (e.isFile() && (!q || rel.toLowerCase().includes(q))) {
        out.push({ path: rel, dir: false });
      }
    }
  }
  await walk(base, 0);
  // Best matches first: name starts with the query, then shorter paths.
  const score = (f) => {
    const name = path.basename(f.path).toLowerCase();
    return (q && name.startsWith(q) ? 0 : q && name.includes(q) ? 1 : 2) * 1000 + f.path.length;
  };
  out.sort((a, b) => score(a) - score(b));
  return { root: base, files: out.slice(0, limit), truncated: out.length > limit || scanned >= scanLimit };
}

const MENTION = /(^|\s)@((?:"[^"]+")|(?:[^\s"]+))/g;

/** Find @path mentions in a message that point to real files under the root. */
export async function resolveMentions(root, text) {
  const found = [];
  for (const m of String(text).matchAll(MENTION)) {
    const rel = m[2].replace(/^"|"$/g, '').replace(/[.,;:!?)]+$/, '');
    try {
      // @~/… and @/… point anywhere on this computer; other mentions are inside the project.
      const outside = /^(~|\/)/.test(rel);
      if (!outside && !root) continue;
      const { abs, rel: r } = outside
        ? { abs: path.resolve(rel.startsWith('~') ? path.join(os.homedir(), rel.slice(1)) : rel), rel }
        : await resolveInside(root, rel);
      const st = await fs.stat(abs);
      if (st.isFile() || st.isDirectory()) found.push({ path: r, abs, dir: st.isDirectory(), size: st.size });
    } catch { /* not a file */ }
  }
  return found.filter((f, i) => found.findIndex((x) => x.path === f.path) === i);
}

/** Inline mentioned text files for API models (Claude Code reads them itself). */
export async function expandMentions(root, text, { maxBytes = 100_000 } = {}) {
  const mentions = await resolveMentions(root, text);
  if (!mentions.length) return { content: text, attachments: [] };
  const blocks = [];
  for (const f of mentions) {
    if (f.dir) {
      const { files } = await listAllFiles(f.abs, { limit: 200 });
      blocks.push(`<attached_folder path="${f.path}">\n${files.map((x) => x.path + (x.dir ? '/' : '')).join('\n')}\n</attached_folder>`);
      continue;
    }
    const buf = await fs.readFile(f.abs);
    const binary = buf.subarray(0, 8000).includes(0);
    if (binary) { blocks.push(`<attached_file path="${f.path}">(binary file, ${f.size} bytes, not included)</attached_file>`); continue; }
    let body = buf.toString('utf8');
    if (body.length > maxBytes) body = `${body.slice(0, maxBytes)}\n…[truncated]`;
    blocks.push(`<attached_file path="${f.path}">\n${body}\n</attached_file>`);
  }
  return { content: `${text}\n\n${blocks.join('\n\n')}`, attachments: mentions.map((f) => f.path) };
}

/**
 * Lists entries for an @-mention outside the project: "~/Downloads/re" lists
 * ~/Downloads entries starting with "re". Folders end with "/".
 */
export async function browsePath(q, { limit = 50 } = {}) {
  const home = os.homedir();
  const expanded = q.startsWith('~') ? path.join(home, q.slice(1)) : q;
  const endsWithSep = /[\\/]$/.test(q);
  const dir = endsWithSep ? expanded : path.dirname(expanded);
  const prefix = endsWithSep ? '' : path.basename(expanded).toLowerCase();
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return { root: dir, files: [], outside: true }; }
  const shown = (full) => (full.startsWith(home + path.sep) ? `~${full.slice(home.length)}` : full);
  const files = entries
    .filter((e) => (!e.name.startsWith('.') || prefix.startsWith('.')) && e.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => {
      const full = path.join(dir, e.name);
      return { path: shown(full) + (e.isDirectory() ? '/' : ''), abs: full, dir: e.isDirectory() };
    });
  return { root: dir, files, outside: true };
}
