import { readSSE, httpError } from '../sse.js';
import { resolveApiKey } from '../settings.js';

const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export const FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function requireKey(settings) {
  const { key } = resolveApiKey(settings, 'gemini');
  if (!key) throw Object.assign(new Error('No Gemini API key. Add one in Settings.'), { status: 400 });
  return key;
}

export async function listModels(settings, fetchImpl = fetch) {
  const key = requireKey(settings);
  const res = await fetchImpl(`${BASE}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw await httpError(res, 'Gemini');
  const json = await res.json();
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
}

export async function test(settings, fetchImpl = fetch) {
  const models = await listModels(settings, fetchImpl);
  return { ok: true, message: `Connected. ${models.length} models available.` };
}

export function toContents(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${m.content}`;
    else out.push({ role, parts: [{ text: m.content }] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function* stream({ settings, messages, model, signal, fetchImpl = fetch }) {
  const key = requireKey(settings);
  const cfg = settings.gemini;
  const id = encodeURIComponent(model || cfg.model);
  const body = { contents: toContents(messages) };
  if (cfg.systemPrompt) body.systemInstruction = { parts: [{ text: cfg.systemPrompt }] };

  const res = await fetchImpl(`${BASE}/v1beta/models/${id}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res, 'Gemini');

  let usage = null;
  for await (const { data } of readSSE(res.body)) {
    if (!data || typeof data !== 'object') continue;
    if (data.error) throw new Error(`Gemini: ${data.error.message}`);
    const cand = data.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.text && !part.thought) yield { type: 'text', text: part.text };
    }
    if (cand?.finishReason && cand.finishReason !== 'STOP') yield { type: 'meta', stopReason: cand.finishReason };
    if (data.usageMetadata) usage = data.usageMetadata;
  }
  if (usage) yield { type: 'meta', usage: { input: usage.promptTokenCount, output: usage.candidatesTokenCount } };
}
