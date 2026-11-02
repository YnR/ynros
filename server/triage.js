import { resolveApiKey } from './settings.js';

/**
 * Decide, with a small fast model, whether a message sent while a task is
 * running should interrupt it or wait in the queue. The harness never
 * interrupts on its own: an "interrupt" verdict only asks the user to confirm.
 */

const SYSTEM = `You triage messages a user sends to an AI assistant while it is still working on a task.
Recommend one of four options. The user decides; you only recommend.

INTERRUPT (stop and re-specify) when the new message:
- tells the assistant to stop, cancel, or change course
- corrects a mistake or wrong assumption the current work depends on
- makes the current work pointless

QUEUE (wait, then handle with the other queued messages) when the new message:
- adds a follow-up or detail for the same task that can wait
- depends on the current work being finished first

PARALLEL (start it now in a branch of this chat, with the same context) when the new message:
- is a separate piece of work in the same project or topic that needs this chat's context
- does not depend on, and won't conflict with, the files the current task is changing

NEW (start it now in a fresh chat without this context) when the new message:
- is unrelated to this chat's topic

Reply with only JSON: {"decision":"interrupt"|"queue"|"parallel"|"new","reason":"<one short sentence>"}`;

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
      const d = String(j.decision || '').toLowerCase();
      const decision = ['interrupt', 'queue', 'parallel', 'new'].find((x) => d.includes(x)) || 'queue';
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
  if (provider === 'claudeCode') { s.claudeCode.permissionMode = 'plan'; s.claudeCode.allowedTools = ''; s.claudeCode.ephemeral = true; }

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
