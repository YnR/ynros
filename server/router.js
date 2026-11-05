import { pickTriageModel, parseVerdict } from './triage.js';

/**
 * "Auto" model: before each turn a small model reads the new message (and a
 * short view of the chat) and picks a tier: small, medium or large. It also
 * says whether the message belongs to this chat, so the UI can suggest a
 * fresh chat when the topic changes.
 *
 * Routing is sticky: switching model mid-chat loses the prompt cache, so a
 * chat moves up a tier when needed but only moves down when it is still short.
 */
export const TIERS = {
  anthropic: { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
  gemini: { small: 'gemini-2.5-flash-lite', medium: 'gemini-2.5-flash', large: 'gemini-2.5-pro' },
  claudeCode: { small: 'haiku', medium: 'sonnet', large: 'opus' },
};
const RANK = { small: 0, medium: 1, large: 2 };

const SYSTEM = `You route a user's message to the right model size and check whether it fits the current chat.

Tiers:
- small: quick facts, rewording, short replies, simple lookups (calendar, email search), formatting.
- medium: most writing, analysis, everyday coding, multi-step tool use, summaries of long material.
- large: hard reasoning, complex or large coding tasks, careful planning, high-stakes or subtle work.

"related" is false only when the new message clearly starts a different topic from the chat so far.
Use null when there is no chat history.

Reply with only JSON: {"tier":"small"|"medium"|"large","related":true|false|null,"reason":"<short>"}`;

export function tiersFor(settings, provider) {
  const custom = settings.routing?.[provider];
  return { ...TIERS[provider], ...(custom && typeof custom === 'object' ? Object.fromEntries(Object.entries(custom).filter(([, v]) => v)) : {}) };
}

function brief(conv) {
  const recent = conv.messages.slice(-4).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  return [`Chat title: ${conv.title || '(new chat)'}`, `Messages so far: ${conv.messages.length}`, ...recent].join('\n');
}

export function parseRoute(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  let j = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { /* default below */ }
  const tier = RANK[j.tier] !== undefined ? j.tier : 'medium';
  const related = j.related === false ? false : j.related === true ? true : null;
  return { tier, related, reason: String(j.reason || '').slice(0, 200) };
}

/** Sticky choice: always move up; move down only early in a chat. */
export function chooseTier(current, proposed, messageCount) {
  if (!current) return proposed;
  if (RANK[proposed] > RANK[current]) return proposed;
  if (RANK[proposed] < RANK[current] && messageCount <= 2) return proposed;
  return current;
}

export async function route({ settings, providers, conv, provider, text }) {
  const { provider: rp, model: rm } = pickTriageModel(settings);
  const impl = providers[rp];
  const s = structuredClone(settings);
  s[rp].systemPrompt = SYSTEM;
  if (rp === 'anthropic') s.anthropic.maxTokens = 150;
  if (rp === 'claudeCode') { s.claudeCode.permissionMode = 'plan'; s.claudeCode.allowedTools = ''; s.claudeCode.ephemeral = true; }
  const prompt = `${brief(conv)}\n\nNew message:\n${text.slice(0, 2000)}`;
  const content = rp === 'claudeCode' ? `${SYSTEM}\n\n${prompt}` : prompt;
  let out = '';
  for await (const ev of impl.stream({
    settings: s, messages: [{ role: 'user', content }], model: rm, signal: AbortSignal.timeout(20_000), conversation: null,
  })) if (ev.type === 'text') out += ev.text;
  const r = parseRoute(out);
  const prevTier = conv.routedTier || null;
  const tier = chooseTier(prevTier, r.tier, conv.messages.length);
  return { ...r, proposedTier: r.tier, tier, model: tiersFor(settings, provider)[tier], router: `${rp}:${rm}` };
}

/** Which tier a fixed model belongs to, if it is one of the provider's tier models. */
export function tierOfModel(settings, provider, model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  const tiers = tiersFor(settings, provider);
  for (const t of ['large', 'medium', 'small']) if (tiers[t] && tiers[t].toLowerCase() === m) return t;
  // Family names: "opus", "claude-opus-…", "gemini-2.5-pro"…
  if (/opus|-pro\b/.test(m)) return 'large';
  if (/sonnet|flash(?!-lite)/.test(m)) return 'medium';
  if (/haiku|flash-lite/.test(m)) return 'small';
  return null;
}

/**
 * A smaller model that would do for this message, or null. Used to suggest
 * (never force) a switch: on a fixed model, and in auto chats that stickiness
 * kept on a bigger tier.
 */
export function smallerSuggestion(settings, provider, currentTier, proposedTier, reason) {
  if (!currentTier || !proposedTier || RANK[proposedTier] >= RANK[currentTier]) return null;
  const model = tiersFor(settings, provider)[proposedTier];
  return model ? { tier: proposedTier, model, from: currentTier, reason: reason || '' } : null;
}

export { parseVerdict };
