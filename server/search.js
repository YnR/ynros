// Search for conversations (fuzzy over titles and message text) and, when
// nothing matches, a fallback that asks Claude to pick the closest items.
import * as store from './store.js';
import { fuzzyScore } from '../public/fuzzy.js';
import { pickTriageModel } from './triage.js';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const textOf = (m) => (typeof m.content === 'string' ? m.content : '');

/** Excerpt around the first occurrence of any query word. */
export function snippet(text, query, width = 140) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  if (at < 0) return clip(flat, width);
  const start = Math.max(0, at - 40);
  return `${start ? '…' : ''}${clip(flat.slice(start), width)}`;
}

/**
 * Fuzzy search: titles count most, then each message. Message bodies are
 * matched per message so words from unrelated turns don't combine.
 */
export async function searchConversations(query, { limit = 40 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const list = await store.listConversations();
  const out = [];
  for (const c of list) {
    let best = fuzzyScore(q, c.title) * 3;
    let where = best ? 'title' : '';
    let snip = '';
    const conv = await store.getConversation(c.id);
    for (const m of conv?.messages || []) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const t = textOf(m);
      if (!t) continue;
      // Long messages: only the substring/subsequence check of the first 20k chars.
      const s = fuzzyScore(q, t.slice(0, 20_000));
      if (s > best) { best = s; where = m.role; snip = snippet(t, q); }
      else if (s && !snip) snip = snippet(t, q);
    }
    if (best > 0) out.push({ ...c, score: best, where, snippet: snip });
  }
  out.sort((a, b) => b.score - a.score || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // Drop weak, scattered matches when there are strong ones.
  const floor = (out[0]?.score || 0) * 0.35;
  return out.filter((r) => r.score >= floor).slice(0, limit);
}

/** Build the candidate list Claude sees for a conversation question. */
export async function conversationCandidates({ max = 300 } = {}) {
  const list = (await store.listConversations()).slice(0, max);
  const out = [];
  for (const c of list) {
    const conv = await store.getConversation(c.id);
    const firstUser = conv?.messages?.find((m) => m.role === 'user');
    const lastReply = [...(conv?.messages || [])].reverse().find((m) => m.role === 'assistant');
    out.push({
      id: c.id,
      text: `${c.title} · ${(c.updatedAt || '').slice(0, 10)} · asked: ${clip(textOf(firstUser || {}).replace(/\s+/g, ' '), 200)} · last reply: ${clip(textOf(lastReply || {}).replace(/\s+/g, ' '), 160)}`,
    });
  }
  return out;
}

const SYSTEM = `You help someone find something in their app. You get what they typed and a numbered list of candidates. Pick the candidates that best match what they are looking for, even if the words differ (synonyms, a description of what it does, a misspelling). If nothing fits, return an empty list.
Reply with only JSON: {"matches":[{"n":<number>,"why":"<a few words>"}],"note":"<one short sentence, optional>"}`;

export function parseMatches(text, count) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { matches: [], note: '' };
  try {
    const j = JSON.parse(m[0]);
    const seen = new Set();
    const matches = (Array.isArray(j.matches) ? j.matches : [])
      .map((x) => ({ n: Number(x.n), why: String(x.why || '').slice(0, 160) }))
      .filter((x) => Number.isInteger(x.n) && x.n >= 1 && x.n <= count && !seen.has(x.n) && seen.add(x.n))
      .slice(0, 8);
    return { matches, note: String(j.note || '').slice(0, 200) };
  } catch { return { matches: [], note: '' }; }
}

/** Ask a small model which candidates match. Candidates: [{id, text}]. */
export async function askClaude({ settings, providers, kind, query, candidates, signal }) {
  const { provider, model } = pickTriageModel(settings);
  const impl = providers[provider];
  const s = structuredClone(settings);
  s[provider] = { ...(s[provider] || {}), systemPrompt: SYSTEM };
  if (provider === 'anthropic') s.anthropic.maxTokens = 600;
  if (provider === 'claudeCode') Object.assign(s.claudeCode, { permissionMode: 'plan', allowedTools: '', ephemeral: true, askInChat: false, noMcp: true });
  const what = kind === 'settings' ? 'a setting in the Settings page' : 'a past conversation';
  const body = `They are looking for ${what}. They typed: "${String(query).slice(0, 300)}"\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. ${String(c.text).slice(0, 400)}`).join('\n')}`;
  const content = provider === 'claudeCode' ? `${SYSTEM}\n\n${body}` : body;
  let text = '';
  const timeout = AbortSignal.timeout(90_000);
  for await (const ev of impl.stream({ settings: s, messages: [{ role: 'user', content }], model, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, conversation: null })) {
    if (ev.type === 'text') text += ev.text;
  }
  const { matches, note } = parseMatches(text, candidates.length);
  return { matches: matches.map((x) => ({ id: candidates[x.n - 1].id, why: x.why })), note, model: `${provider}:${model}` };
}
