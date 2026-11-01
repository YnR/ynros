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
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(DIR(), f), 'utf8'));
      out.push({ id: c.id, title: c.title, provider: c.provider, model: c.model, updatedAt: c.updatedAt });
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

export async function saveConversation(conv) {
  await fs.mkdir(DIR(), { recursive: true, mode: 0o700 });
  conv.updatedAt = new Date().toISOString();
  const file = fileFor(conv.id);
  await fs.writeFile(file + '.tmp', JSON.stringify(conv, null, 2), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
  return conv;
}

export async function createConversation({ provider, model, title } = {}) {
  const now = new Date().toISOString();
  return saveConversation({
    id: crypto.randomUUID(),
    title: title || 'New chat',
    provider,
    model: model || '',
    createdAt: now,
    updatedAt: now,
    claudeCodeSessionId: null,
    messages: [],
  });
}

export async function deleteConversation(id) {
  try { await fs.unlink(fileFor(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
