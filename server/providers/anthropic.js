import { readSSE, httpError } from '../sse.js';
import { resolveApiKey } from '../settings.js';
import { callTool, MAX_TOOL_ROUNDS } from '../toolLoop.js';

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

export async function* stream({ settings, messages, model, signal, fetchImpl = fetch, tools = [], runTool, systemNote = '' }) {
  const key = requireKey(settings);
  const cfg = settings.anthropic;
  const msgs = toApiMessages(messages);
  const system = [cfg.systemPrompt, tools.length ? systemNote : ''].filter(Boolean).join('\n\n');
  const total = { input: 0, output: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: model || cfg.model,
      max_tokens: cfg.maxTokens || 8192,
      messages: msgs,
      stream: true,
    };
    if (system) body.system = system;
    if (tools.length && round < MAX_TOOL_ROUNDS) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    }

    const res = await fetchImpl(`${BASE}/v1/messages`, {
      method: 'POST', headers: headers(key), body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw await httpError(res, 'Anthropic');

    const blocks = [];
    let stopReason = null;
    for await (const { data } of readSSE(res.body)) {
      if (!data || typeof data !== 'object') continue;
      switch (data.type) {
        case 'message_start':
          total.input += data.message?.usage?.input_tokens || 0;
          break;
        case 'content_block_start': {
          const b = data.content_block || {};
          blocks[data.index] = b.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, json: '' }
            : b.type === 'text' ? { type: 'text', text: '' } : null;
          break;
        }
        case 'content_block_delta': {
          const b = blocks[data.index];
          if (data.delta?.type === 'text_delta') {
            if (b) b.text += data.delta.text;
            yield { type: 'text', text: data.delta.text };
          } else if (data.delta?.type === 'input_json_delta' && b) {
            b.json += data.delta.partial_json;
          }
          break;
        }
        case 'message_delta':
          total.output += data.usage?.output_tokens || 0;
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          break;
        case 'error':
          throw new Error(`Anthropic: ${data.error?.message || 'stream error'}`);
      }
    }

    const calls = blocks.filter((b) => b?.type === 'tool_use');
    if (stopReason !== 'tool_use' || !calls.length || !runTool) {
      if (stopReason && stopReason !== 'end_turn') yield { type: 'meta', stopReason };
      break;
    }
    for (const c of calls) { try { c.input = c.json ? JSON.parse(c.json) : {}; } catch { c.input = {}; } }
    msgs.push({
      role: 'assistant',
      content: blocks.filter(Boolean).filter((b) => b.type !== 'text' || b.text).map((b) => (b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'tool_use', id: b.id, name: b.name, input: b.input })),
    });
    const results = [];
    for (const c of calls) {
      const r = yield* callTool({ id: c.id, name: c.name, args: c.input, runTool });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.output, ...(r.isError ? { is_error: true } : {}) });
    }
    msgs.push({ role: 'user', content: results });
    yield { type: 'text', text: '\n\n' };
  }
  yield { type: 'meta', usage: total };
}
