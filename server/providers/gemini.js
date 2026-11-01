import { readSSE, httpError } from '../sse.js';
import { resolveApiKey } from '../settings.js';
import { callTool, MAX_TOOL_ROUNDS } from '../toolLoop.js';

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
    const text = m.providerContent || m.content;
    if (!text) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${text}`;
    else out.push({ role, parts: [{ text }] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function* stream({ settings, messages, model, signal, fetchImpl = fetch, tools = [], runTool, systemNote = '' }) {
  const key = requireKey(settings);
  const cfg = settings.gemini;
  const id = encodeURIComponent(model || cfg.model);
  const contents = toContents(messages);
  const system = [cfg.systemPrompt, systemNote].filter(Boolean).join('\n\n');
  const total = { input: 0, output: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length && round < MAX_TOOL_ROUNDS) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.schema) })) }];
    }

    const res = await fetchImpl(`${BASE}/v1beta/models/${id}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await httpError(res, 'Gemini');

    const modelParts = [];
    let usage = null;
    let finish = null;
    for await (const { data } of readSSE(res.body)) {
      if (!data || typeof data !== 'object') continue;
      if (data.error) throw new Error(`Gemini: ${data.error.message}`);
      const cand = data.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        // Keep parts verbatim (including thought signatures) to send back with tool results.
        modelParts.push(part);
        if (part.text && !part.thought) yield { type: 'text', text: part.text };
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (data.usageMetadata) usage = data.usageMetadata;
    }
    if (usage) { total.input += usage.promptTokenCount || 0; total.output += usage.candidatesTokenCount || 0; }

    const calls = modelParts.filter((p) => p.functionCall);
    if (!calls.length || !runTool) {
      if (finish && finish !== 'STOP') yield { type: 'meta', stopReason: finish };
      break;
    }
    contents.push({ role: 'model', parts: modelParts });
    const responses = [];
    for (const [i, p] of calls.entries()) {
      const { name, args } = p.functionCall;
      const r = yield* callTool({ id: p.functionCall.id || `call-${round}-${i}`, name, args: args || {}, runTool });
      let response;
      try { response = JSON.parse(r.output); } catch { response = { result: r.output }; }
      if (Array.isArray(response) || typeof response !== 'object' || response === null) response = { result: response };
      responses.push({ functionResponse: { name, ...(p.functionCall.id ? { id: p.functionCall.id } : {}), response } });
    }
    contents.push({ role: 'user', parts: responses });
    yield { type: 'text', text: '\n\n' };
  }
  yield { type: 'meta', usage: total };
}

/** Gemini accepts an OpenAPI subset: drop empty `properties` objects. */
function geminiSchema(schema) {
  if (schema.type === 'object' && !Object.keys(schema.properties || {}).length) return undefined;
  return schema;
}
