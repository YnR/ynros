// What a model sees of a chat: turns after the last /clear, with pasted images loaded.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Messages since the last /clear marker, without harness notices. */
export function activeMessages(messages) {
  let start = 0;
  messages.forEach((m, i) => { if (m.role === 'system' && m.kind === 'clear') start = i + 1; });
  return messages.slice(start).filter((m) => m.role === 'user' || m.role === 'assistant');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const imageMime = (p) => MIME[path.extname(p).toLowerCase()] || null;

/** Loads pasted or attached images (msg.images: [path]) as base64 for API models. */
export async function withImageData(messages) {
  return Promise.all(messages.map(async (m) => {
    if (!m.images?.length) return m;
    const imageData = [];
    for (const p of m.images) {
      const mime = imageMime(p);
      if (!mime) continue;
      try { imageData.push({ mime, data: (await fs.readFile(p)).toString('base64') }); } catch { /* file gone */ }
    }
    return { ...m, imageData };
  }));
}

/** A model's context window, for the saturation donut. */
export function contextLimit(provider, model = '') {
  const m = String(model).toLowerCase();
  if (provider === 'gemini') return 1_048_576;
  if (m.includes('[1m]')) return 1_000_000;
  return 200_000;
}

/**
 * For a Claude Code chat with no session to resume (a branch, or after switching
 * provider), earlier turns are passed in the prompt so the context carries over.
 */
export function transcriptPrefix(messages, { maxChars = 40_000 } = {}) {
  const prior = messages.slice(0, -1).filter((m) => m.content);
  if (!prior.length) return '';
  const lines = [];
  let used = 0;
  for (const m of [...prior].reverse()) {
    const text = String(m.providerContent || m.content).slice(0, 4000);
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return `Earlier in this conversation:\n\n${lines.join('\n\n')}\n\n---\n\nContinue from there. New message:\n\n`;
}
