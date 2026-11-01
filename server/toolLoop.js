/** Shared helpers for running tool calls inside a provider's stream. */

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const v = args.query ?? args.title ?? args.message_id ?? args.file_id ?? args.name ?? args.calendar_id;
  return clip(typeof v === 'string' ? v : JSON.stringify(args), 160);
}

/**
 * Run one tool call. Yields UI events and returns { output, isError } where
 * output is the string handed back to the model.
 */
export async function* callTool({ id, name, args, runTool }) {
  if (name === 'load_skill') {
    yield { type: 'skill', id, name: args?.name || 'skill', args: '', text: null };
  } else {
    yield { type: 'tool', name, input: summarizeArgs(args) };
  }
  try {
    const result = await runTool(name, args);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
    if (name === 'load_skill') {
      yield { type: 'skill', id, name: result.name, args: '', text: result.instructions, path: result.path };
    } else {
      yield { type: 'tool_result', text: clip(output, 1500), isError: false };
    }
    return { output, isError: false };
  } catch (e) {
    yield { type: 'tool_result', text: e.message, isError: true };
    return { output: `Error: ${e.message}`, isError: true };
  }
}

export const MAX_TOOL_ROUNDS = 12;
