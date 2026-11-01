// Minimal Server-Sent Events reader for fetch() response bodies.
// Yields { event, data } objects; data is parsed JSON when possible.
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = null;
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) { event = null; return null; }
    const raw = dataLines.join('\n');
    dataLines = [];
    const ev = event;
    event = null;
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* keep raw string */ }
    return { event: ev, data };
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const msg = flush();
        if (msg) yield msg;
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
  const last = flush();
  if (last) yield last;
}

export async function httpError(res, label) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || text;
    } catch { detail = text; }
  } catch { /* ignore */ }
  const err = new Error(`${label} ${res.status}: ${detail || res.statusText}`.trim());
  err.status = res.status;
  return err;
}
