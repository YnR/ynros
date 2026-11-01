#!/usr/bin/env node
// Stands in for the `claude` CLI in tests: echoes args and stdin as stream-json.
if (process.argv.includes('--version')) {
  console.log('9.9.9 (Fake Claude Code)');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  if (input.includes('You triage messages')) {
    const msg = input.split('## New message').pop();
    const decision = /STOP/.test(msg) ? 'interrupt' : 'queue';
    const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ decision, reason: 'fake' }) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'triage' });
    return;
  }
  if (input.includes('slow')) await new Promise((r) => setTimeout(r, 600));
  const args = process.argv.slice(2);
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const sid = resume || 'sess-123';
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' });
  const reply = `echo: ${input}${resume ? ` (resumed ${resume})` : ''}`;
  for (const chunk of [reply.slice(0, 5), reply.slice(5)]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file.txt' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid, total_cost_usd: 0.0012, usage: { input_tokens: 3, output_tokens: 4 } });
});
