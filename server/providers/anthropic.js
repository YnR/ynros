import { readSSE, httpError } from '../sse.js';
import { resolveApiKey } from '../settings.js';

const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const VERSION = '2023-06-01';

export const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function headers(key) {
  return { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' };
}

function requireKey(settings) {
  const { key } = resolveApiKey(settings, 'anthropic');
  if (!key) throw Object.assign(new Error('No Anthropic API key. Add one in Settings.'), { status: 400 });
  return key;
}

export async function listModels(settings, fetchImpl = fetch) {
  const key = requireKey(settings);
  const res = await fetchImpl(`${BASE}/v1/models?limit=100`, { headers: headers(key) });
  if (!res.ok) throw await httpError(res, 'Anthropic');
  const json = await res.json();
  return (json.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

export async function test(settings, fetchImpl = fetch) {
  const models = await listModels(settings, fetchImpl);
  return { ok: true, message: `Connected. ${models.length} models available.` };
}

/** Convert harness history into Messages API format (merging consecutive same-role turns). */
export function toApiMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function* stream({ settings, messages, model, signal, fetchImpl = fetch }) {
  const key = requireKey(settings);
  const cfg = settings.anthropic;
  const body = {
    model: model || cfg.model,
    max_tokens: cfg.maxTokens || 8192,
    messages: toApiMessages(messages),
    stream: true,
  };
  if (cfg.systemPrompt) body.system = cfg.systemPrompt;

  const res = await fetchImpl(`${BASE}/v1/messages`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw await httpError(res, 'Anthropic');

  const usage = {};
  for await (const { data } of readSSE(res.body)) {
    if (!data || typeof data !== 'object') continue;
    switch (data.type) {
      case 'message_start':
        Object.assign(usage, data.message?.usage);
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') yield { type: 'text', text: data.delta.text };
        break;
      case 'message_delta':
        Object.assign(usage, data.usage);
        if (data.delta?.stop_reason) yield { type: 'meta', stopReason: data.delta.stop_reason };
        break;
      case 'error':
        throw new Error(`Anthropic: ${data.error?.message || 'stream error'}`);
    }
  }
  yield { type: 'meta', usage: { input: usage.input_tokens, output: usage.output_tokens } };
}
