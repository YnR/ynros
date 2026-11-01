import { resolveApiKey } from './settings.js';

/**
 * Decide, with a small fast model, whether a message sent while a task is
 * running should interrupt it or wait in the queue. The harness never
 * interrupts on its own: an "interrupt" verdict only asks the user to confirm.
 */

const SYSTEM = `You triage messages a user sends to an AI assistant while it is still working on a task.
Decide whether the new message should INTERRUPT the current task or be QUEUED until it finishes.

Interrupt when the new message:
- tells the assistant to stop, cancel, or change course
- corrects a mistake or wrong assumption the current work depends on
- is urgent or time-sensitive, or makes the current work pointless

Queue when the new message:
- adds a follow-up, extra request, or detail that can wait
- is unrelated to the current task
- is a question that does not affect the current work

Reply with only JSON: {"decision":"interrupt"|"queue","reason":"<one short sentence>"}`;

const SMALL_MODELS = {
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-2.5-flash-lite',
  claudeCode: 'haiku',
};

/** Pick the provider + model for triage based on settings and what is connected. */
export function pickTriageModel(settings) {
  const cfg = settings.triage || {};
  if (cfg.provider && cfg.provider !== 'auto') {
    return { provider: cfg.provider, model: cfg.model || SMALL_MODELS[cfg.provider] };
  }
  if (resolveApiKey(settings, 'anthropic').key) return { provider: 'anthropic', model: SMALL_MODELS.anthropic };
  if (resolveApiKey(settings, 'gemini').key) return { provider: 'gemini', model: SMALL_MODELS.gemini };
  return { provider: 'claudeCode', model: SMALL_MODELS.claudeCode };
}

export function buildTriagePrompt({ task, progress, subagents, queued, message }) {
  const lines = [
    '## Current task (what the user asked)',
    task || '(unknown)',
    '',
    '## Progress so far',
    (progress || '(no output yet)').slice(-1500),
  ];
  if (subagents?.length) {
    lines.push('', '## Subagents', ...subagents.map((s) => `- ${s.description || s.agentType}: ${s.status}`));
  }
  if (queued?.length) {
    lines.push('', '## Already queued', ...queued.map((q) => `- ${q}`));
  }
  lines.push('', '## New message', message);
  return lines.join('\n');
}

export function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const decision = /interrupt/i.test(j.decision) ? 'interrupt' : 'queue';
      return { decision, reason: String(j.reason || '').slice(0, 300) };
    } catch { /* fall through */ }
  }
  if (/\binterrupt\b/i.test(text || '')) return { decision: 'interrupt', reason: '' };
  return { decision: 'queue', reason: '' };
}

export async function triage({ settings, providers, context, signal }) {
  if (settings.triage && settings.triage.enabled === false) {
    return { decision: 'queue', reason: 'Triage is off, so new messages wait their turn.', model: null };
  }
  const { provider, model } = pickTriageModel(settings);
  const impl = providers[provider];
  // Run the small model with a dedicated system prompt and no tools or history.
  const s = structuredClone(settings);
  s[provider].systemPrompt = SYSTEM;
  if (provider === 'anthropic') s.anthropic.maxTokens = 200;
  if (provider === 'claudeCode') { s.claudeCode.permissionMode = 'plan'; s.claudeCode.allowedTools = ''; }

  const content = provider === 'claudeCode'
    ? `${SYSTEM}\n\n${buildTriagePrompt(context)}`
    : buildTriagePrompt(context);
  let text = '';
  const timeout = AbortSignal.timeout(45_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for await (const ev of impl.stream({
    settings: s, messages: [{ role: 'user', content }], model, signal: combined, conversation: null,
  })) {
    if (ev.type === 'text') text += ev.text;
  }
  return { ...parseVerdict(text), model: `${provider}:${model}` };
}
