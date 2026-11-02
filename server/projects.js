import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './settings.js';

/**
 * Projects are folders on disk that hold instructions (CLAUDE.md) and files
 * (outputs/). New projects go in the default host folder from Settings;
 * existing folders can be added too. The registry lives in DATA_DIR.
 */
const REGISTRY = () => path.join(DATA_DIR, 'projects.json');

export function defaultHostFolder() {
  return path.join(os.homedir(), 'src');
}

// A folder in the host folder counts as a project when it has one of these.
const MARKERS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.git', '.claude'];

async function markersIn(dir) {
  const found = [];
  for (const m of MARKERS) {
    try { await fs.access(path.join(dir, m)); found.push(m); } catch { /* absent */ }
  }
  return found;
}

/** Explains whether a folder shows up as a project, and why not. */
export async function explain(settings, folder) {
  const host = settings.projects?.hostFolder || defaultHostFolder();
  const dir = path.resolve(String(folder || '').replace(/^~(?=$|[\\/])/, os.homedir()));
  const st = await fs.stat(dir).catch(() => null);
  if (!st) return { listed: false, reasons: [`${dir} does not exist.`] };
  if (!st.isDirectory()) return { listed: false, reasons: [`${dir} is a file, not a folder.`] };
  const all = await listProjects(settings);
  const hit = all.find((p) => path.resolve(p.path) === dir);
  if (hit) return { listed: true, project: hit, reasons: [hit.discovered ? `Found automatically in ${host} (has ${hit.markers?.join(', ')}).` : 'Added to the project list.'] };
  const reasons = [];
  if (path.dirname(dir) !== path.resolve(host)) reasons.push(`Only folders directly inside the projects folder (${host}) are found automatically; this one is in ${path.dirname(dir)}. Add it with "+ Project → Use an existing folder".`);
  const markers = await markersIn(dir);
  if (!markers.length) reasons.push(`It has none of ${MARKERS.join(', ')}, which is how a project is recognized.`);
  if (path.basename(dir).startsWith('.')) reasons.push('Hidden folders are skipped.');
  return { listed: false, reasons: reasons.length ? reasons : ['It should be listed; reload the page.'] };
}

function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60) || 'project';
}

async function readRegistry() {
  try { return JSON.parse(await fs.readFile(REGISTRY(), 'utf8')); } catch { return []; }
}

async function writeRegistry(list) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(REGISTRY(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

const TEMPLATE = (name) => `# ${name}

Instructions for the assistant in this project. Every chat in the project reads this file.

## Goal

Describe what this project is about.

## How to work

- Save anything you produce for me in \`outputs/\`.
- Keep notes in \`notes/\` if they help later chats.
`;

export async function listProjects(settings) {
  const list = await readRegistry();
  // Pick up existing projects in the host folder: repos and folders with instructions.
  const host = settings.projects?.hostFolder || defaultHostFolder();
  try {
    for (const e of await fs.readdir(host, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(host, e.name);
      if (list.some((x) => x.path === p)) continue;
      const markers = await markersIn(p);
      if (markers.length) list.push({ id: slug(e.name), name: e.name, path: p, discovered: true, markers });
    }
  } catch { /* host folder not created yet */ }
  const seen = new Set();
  return list.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
}

export async function getProject(settings, id) {
  if (!id) return null;
  return (await listProjects(settings)).find((p) => p.id === id) || null;
}

/** Create a new project folder (or adopt an existing folder with `existingPath`). */
export async function createProject(settings, { name, existingPath }) {
  name = String(name || '').trim();
  if (!name && !existingPath) throw Object.assign(new Error('Give the project a name'), { status: 400 });
  const list = await readRegistry();
  let dir;
  if (existingPath) {
    dir = path.resolve(existingPath.replace(/^~(?=$|[\\/])/, os.homedir()));
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw Object.assign(new Error(`Folder not found: ${dir}`), { status: 400 });
    name ||= path.basename(dir);
  } else {
    const host = settings.projects?.hostFolder || defaultHostFolder();
    dir = path.join(host, name.replace(/[\\/:*?"<>|]/g, '-'));
    const exists = await fs.stat(dir).catch(() => null);
    if (exists) throw Object.assign(new Error(`A folder named "${path.basename(dir)}" already exists in ${host}`), { status: 409 });
  }
  let id = slug(name);
  const all = await listProjects(settings);
  for (let n = 2; all.some((p) => p.id === id); n++) id = `${slug(name)}-${n}`;
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
  try { await fs.writeFile(path.join(dir, 'CLAUDE.md'), TEMPLATE(name), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const project = { id, name, path: dir, createdAt: new Date().toISOString() };
  list.push(project);
  await writeRegistry(list);
  return project;
}

export async function removeProject(id) {
  // Forget the project; never deletes the folder.
  await writeRegistry((await readRegistry()).filter((p) => p.id !== id));
}

export async function readInstructions(project) {
  if (!project) return '';
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try { return await fs.readFile(path.join(project.path, name), 'utf8'); } catch { /* try next */ }
  }
  return '';
}

/**
 * Register an existing folder as a project without writing anything into it
 * (used when importing past chats that ran in that folder). Returns the project.
 */
export async function registerFolder(settings, dir, { name, via } = {}) {
  dir = path.resolve(dir);
  const all = await listProjects(settings);
  const known = all.find((p) => path.resolve(p.path) === dir);
  if (known) return known;
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return null;
  name ||= path.basename(dir);
  let id = slug(name);
  for (let n = 2; all.some((p) => p.id === id); n++) id = `${slug(name)}-${n}`;
  const project = { id, name, path: dir, createdAt: new Date().toISOString(), ...(via ? { addedBy: via } : {}) };
  const list = await readRegistry();
  list.push(project);
  await writeRegistry(list);
  return project;
}
