import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './settings.js';

const DIR = () => path.join(DATA_DIR, 'conversations');
const fileFor = (id) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Object.assign(new Error('Bad conversation id'), { status: 400 });
  return path.join(DIR(), `${id}.json`);
};

export async function listConversations() {
  let files = [];
  try { files = await fs.readdir(DIR()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue; // skips in-flight .tmp files
    try {
      const c = JSON.parse(await fs.readFile(path.join(DIR(), f), 'utf8'));
      out.push({ id: c.id, title: c.title, provider: c.provider, model: c.model, projectId: c.projectId || null, updatedAt: c.updatedAt });
    } catch { /* skip corrupt file */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getConversation(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const writes = new Map(); // id -> promise of the last queued write

/** Atomic save; writes to the same chat are serialized so they can't interleave. */
export function saveConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  const file = fileFor(conv.id);
  const data = JSON.stringify(conv, null, 2);
  const prev = writes.get(conv.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fs.mkdir(DIR(), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  });
  writes.set(conv.id, next);
  next.finally(() => { if (writes.get(conv.id) === next) writes.delete(conv.id); }).catch(() => {});
  return next.then(() => conv);
}

export async function createConversation({ provider, model, title, projectId = null } = {}) {
  const now = new Date().toISOString();
  return saveConversation({
    id: crypto.randomUUID(),
    title: title || 'New chat',
    provider,
    model: model || '',
    createdAt: now,
    updatedAt: now,
    projectId,
    claudeCodeSessionId: null,
    messages: [],
  });
}

export async function deleteConversation(id) {
  try { await fs.unlink(fileFor(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
