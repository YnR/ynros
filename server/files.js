import fs from 'node:fs/promises';
import path from 'node:path';

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
