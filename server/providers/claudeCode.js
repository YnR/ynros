import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

// Aliases accepted by `claude --model`. Empty = the CLI's own default.
export const FALLBACK_MODELS = ['', 'opus', 'sonnet', 'haiku'];

export async function listModels() {
  return FALLBACK_MODELS.map((id) => ({ id, label: id || 'CLI default' }));
}

function splitList(s) {
  return String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function buildArgs({ settings, model, sessionId, mcpConfig }) {
  const cfg = settings.claudeCode;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const m = model ?? cfg.model;
  if (m) args.push('--model', m);
  if (sessionId) args.push('--resume', sessionId);
  if (cfg.permissionMode) args.push('--permission-mode', cfg.permissionMode);
  const tools = splitList(cfg.allowedTools);
  if (mcpConfig) {
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    // The harness tools only read data, create drafts, or add calendar events without emailing guests.
    tools.push('mcp__harness');
  }
  if (tools.length) args.push('--allowedTools', ...tools);
  if (cfg.systemPrompt) args.push('--append-system-prompt', cfg.systemPrompt);
  return args;
}

export function test(settings, spawnImpl = nodeSpawn) {
  const cfg = settings.claudeCode;
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnImpl(cfg.binaryPath || 'claude', ['--version'], { cwd: cfg.workingDirectory || undefined });
    } catch (e) {
      resolve({ ok: false, message: e.message });
      return;
    }
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({
      ok: false,
      message: e.code === 'ENOENT'
        ? `Could not run "${cfg.binaryPath}". Is Claude Code installed? (npm i -g @anthropic-ai/claude-code)`
        : e.message,
    }));
    child.on('close', (code) => resolve(code === 0
      ? { ok: true, message: `Found ${out.trim()}` }
      : { ok: false, message: out.trim() || `exited with code ${code}` }));
  });
}

// Tool names Claude Code uses to launch a subagent.
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
// How the CLI prefixes an injected skill body.
const SKILL_BODY = /^Base directory for this skill:\s*([^\n]*)\n?/;
const now = () => new Date().toISOString();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function mapTaskStatus(s) {
  if (!s) return null;
  if (/complet|success|done/i.test(s)) return 'done';
  if (/fail|error/i.test(s)) return 'failed';
  if (/stop|cancel|kill/i.test(s)) return 'stopped';
  if (/run|progress|start/i.test(s)) return 'running';
  return null;
}

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? input.prompt;
  const s = typeof v === 'string' ? v : JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function toolResultText(block) {
  const c = block.content;
  const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

/**
 * Run one turn through the Claude Code CLI. Claude Code keeps its own history,
 * so only the newest user message is sent and the session is resumed by id.
 */
export async function* stream({ settings, messages, model, signal, conversation, spawnImpl = nodeSpawn, mcpConfig, cwd }) {
  const cfg = settings.claudeCode;
  const prompt = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const args = buildArgs({ settings, model, sessionId: conversation?.claudeCodeSessionId, mcpConfig });

  const child = spawnImpl(cfg.binaryPath || 'claude', args, {
    cwd: cwd || cfg.workingDirectory || undefined,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const onAbort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });

  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.on('error', (e) => { spawnError = e; resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const rl = readline.createInterface({ input: child.stdout });
  // Subagents are keyed by the tool_use id of the Agent/Task call that started them.
  const subagents = new Map(); // id -> { status, background }
  const taskToTool = new Map(); // CLI task_id -> tool_use id
  const skills = []; // { id, name, args, text? } in order of use
  const subagentEvent = (id, patch) => {
    const sa = subagents.get(id) || { status: 'running', background: false };
    if (patch.status) sa.status = patch.status;
    if (patch.background !== undefined) sa.background = patch.background;
    subagents.set(id, sa);
    return { type: 'subagent', id, ...patch };
  };
  const finishSubagents = (status) => {
    const out = [];
    for (const [id, sa] of subagents) {
      if (sa.status === 'running') out.push(subagentEvent(id, { status, endedAt: now() }));
    }
    return out;
  };
  const skillEvent = (sk) => ({ type: 'skill', id: sk.id, name: sk.name, args: sk.args, text: sk.text ?? null });

  let sawPartialText = false;
  let emittedText = false; // separate consecutive assistant messages with a blank line
  let needBreak = false;
  let gotResult = false;
  const pendingFinal = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === 'system') {
        if (ev.subtype === 'init') {
          yield { type: 'meta', sessionId: ev.session_id, model: ev.model };
          continue;
        }
        // Subagent lifecycle events (task_started / task_progress / task_updated / task_notification).
        if (!/^task_/.test(ev.subtype || '') || !ev.task_id) continue;
        // Only agent tasks are subagents; background shell commands also report as tasks.
        const isAgent = ev.task_type === 'local_agent' || ev.subagent_type
          || (ev.tool_use_id && subagents.has(ev.tool_use_id)) || taskToTool.has(ev.task_id);
        if (!isAgent) continue;
        if (ev.tool_use_id) taskToTool.set(ev.task_id, ev.tool_use_id);
        const id = ev.tool_use_id || taskToTool.get(ev.task_id) || ev.task_id;
        if (ev.subtype === 'task_started') {
          yield subagentEvent(id, {
            status: 'running',
            agentType: ev.subagent_type || undefined,
            description: ev.description || undefined,
            background: Boolean(ev.is_backgrounded),
            ...(subagents.has(id) ? {} : { startedAt: now() }),
          });
        } else if (ev.subtype === 'task_progress') {
          yield subagentEvent(id, {
            activity: ev.description || (ev.last_tool_name ? `Using ${ev.last_tool_name}` : undefined),
            toolUses: ev.usage?.tool_uses,
            tokens: ev.usage?.total_tokens,
          });
        } else {
          const status = mapTaskStatus(ev.status || ev.patch?.status);
          if (status && status !== 'running') {
            yield subagentEvent(id, {
              status, endedAt: now(), ...(ev.summary ? { result: clip(ev.summary, 400) } : {}),
            });
          }
        }
      } else if (ev.type === 'stream_event') {
        const e = ev.event;
        if (ev.parent_tool_use_id) continue;
        if (e?.type === 'message_start' && emittedText) needBreak = true;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          sawPartialText = true;
          if (needBreak) { yield { type: 'text', text: '\n\n' }; needBreak = false; }
          emittedText = true;
          yield { type: 'text', text: e.delta.text };
        }
      } else if (ev.type === 'assistant') {
        const parent = ev.parent_tool_use_id;
        if (parent) {
          // Activity inside a subagent: report what it is doing, not its text.
          for (const block of ev.message?.content || []) {
            if (block.type === 'tool_use') {
              yield subagentEvent(parent, { activity: `${block.name} ${summarize(block.input)}`.trim(), toolUse: true });
            }
          }
          continue;
        }
        for (const block of ev.message?.content || []) {
          if (block.type === 'text' && !sawPartialText) {
            if (emittedText) yield { type: 'text', text: '\n\n' };
            emittedText = true;
            needBreak = false;
            yield { type: 'text', text: block.text };
          }
          if (block.type !== 'tool_use') continue;
          if (SUBAGENT_TOOLS.has(block.name)) {
            yield subagentEvent(block.id, {
              status: 'running',
              agentType: block.input?.subagent_type || 'general-purpose',
              description: block.input?.description || clip(block.input?.prompt || '', 80),
              background: Boolean(block.input?.run_in_background),
              startedAt: now(),
            });
          } else if (block.name === 'Skill') {
            const sk = { id: block.id, name: block.input?.skill || 'skill', args: block.input?.args || '' };
            skills.push(sk);
            yield skillEvent(sk);
          } else {
            yield { type: 'tool', name: block.name, input: summarize(block.input) };
          }
        }
        sawPartialText = false;
      } else if (ev.type === 'user') {
        if (ev.parent_tool_use_id) continue;
        for (const block of ev.message?.content || []) {
          if (block?.type === 'text' && SKILL_BODY.test(block.text)) {
            // The CLI injects the skill's text as a synthetic user message.
            // Attach it to the skill call instead of showing it inline.
            let sk = skills.find((x) => x.text == null);
            if (!sk) {
              const dir = block.text.match(SKILL_BODY)[1].trim();
              sk = { id: `skill-${skills.length + 1}`, name: dir.split(/[\\/]/).pop() || 'skill', args: '' };
              skills.push(sk);
            }
            sk.text = block.text.replace(SKILL_BODY, '').replace(/^\s+/, '');
            sk.path = block.text.match(SKILL_BODY)[1].trim();
            yield { ...skillEvent(sk), path: sk.path };
            continue;
          }
          if (block?.type !== 'tool_result') continue;
          if (subagents.has(block.tool_use_id)) {
            // A backgrounded agent returns right away; its end comes later as a task event.
            if (subagents.get(block.tool_use_id).background) continue;
            const status = block.is_error ? 'failed' : 'done';
            yield subagentEvent(block.tool_use_id, { status, endedAt: now(), result: clip(toolResultText(block), 400) });
          } else if (skills.some((x) => x.id === block.tool_use_id)) {
            if (block.is_error) yield { type: 'tool_result', text: toolResultText(block), isError: true };
          } else {
            yield { type: 'tool_result', text: toolResultText(block), isError: Boolean(block.is_error) };
          }
        }
      } else if (ev.type === 'result') {
        gotResult = true;
        yield* finishSubagents('stopped');
        if (ev.is_error && ev.subtype !== 'success') {
          yield { type: 'error', message: ev.result || ev.subtype };
        }
        yield {
          type: 'meta',
          sessionId: ev.session_id,
          costUsd: ev.total_cost_usd,
          usage: { input: ev.usage?.input_tokens, output: ev.usage?.output_tokens },
        };
      }
    }
  } finally {
    // Anything still marked running when the CLI stops did not finish.
    for (const ev of finishSubagents('stopped')) pendingFinal.push(ev);
    signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  yield* pendingFinal;
  const code = await exited;
  if (spawnError) {
    throw new Error(spawnError.code === 'ENOENT'
      ? `Could not run "${cfg.binaryPath}". Check the Claude Code path in Settings.`
      : spawnError.message);
  }
  if (!gotResult && !signal?.aborted && code !== 0) {
    throw new Error(`Claude Code exited with code ${code}: ${stderr.trim().slice(-1000)}`);
  }
}
