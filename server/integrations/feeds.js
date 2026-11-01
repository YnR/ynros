/**
 * Sources for the Today view: RSS/Atom feeds and news topics (via Google
 * News RSS search). Small, dependency-free feed parsing.
 */

export function parseSources(settings) {
  const s = settings.sources || {};
  const feeds = String(s.feeds || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const m = line.match(/^(.*?)\s*\|\s*(\S+)$/);
    const url = m ? m[2] : line;
    let name = m ? m[1] : url;
    if (!m) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ } }
    return { kind: 'feed', name, url };
  });
  const [hl, gl] = (s.newsRegion || 'en-US:US').split(':');
  const topics = String(s.newsTopics || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean).map((topic) => ({
    kind: 'news',
    name: `News: ${topic}`,
    url: `https://news.google.com/rss/search?${new URLSearchParams({ q: `${topic} when:2d`, hl, gl: gl || 'US', ceid: `${gl || 'US'}:${(hl || 'en').split('-')[0]}` })}`,
  }));
  return [...feeds, ...topics];
}

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

const strip = (html) => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

export function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const re = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  for (const block of xml.match(re) || []) {
    let link = '';
    if (isAtom) {
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || block.match(/<link[^>]*href=["']([^"']+)/i);
      link = alt ? decode(alt[1]) : '';
    } else {
      link = strip(tag(block, 'link'));
    }
    const date = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const d = date ? new Date(strip(date)) : null;
    items.push({
      title: strip(tag(block, 'title')),
      link,
      date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
      summary: strip(tag(block, isAtom ? 'summary' : 'description') || tag(block, 'content')).slice(0, 400),
      source: strip(tag(block, 'source')) || undefined,
    });
  }
  const title = strip(tag(xml.split(/<(item|entry)[\s>]/i)[0], 'title'));
  return { title, items };
}

const cache = new Map();

export async function loadSource(src, fetchImpl = fetch) {
  const hit = cache.get(src.url);
  if (hit && Date.now() - hit.at < 20 * 60_000) return hit.data;
  const res = await fetchImpl(src.url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${src.name}: ${res.status}`);
  const data = parseFeed(await res.text());
  cache.set(src.url, { at: Date.now(), data });
  return data;
}

/** Recent items across all sources, newest first. */
export async function recentItems(settings, { sinceHours = 36, perSource = 6 } = {}) {
  const since = Date.now() - sinceHours * 3_600_000;
  const out = [];
  const errors = [];
  await Promise.all(parseSources(settings).map(async (src) => {
    try {
      const { items } = await loadSource(src);
      const recent = items.filter((i) => !i.date || new Date(i.date).getTime() >= since).slice(0, perSource);
      out.push({ name: src.name, kind: src.kind, items: recent });
    } catch (e) { errors.push(e.message); }
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { sources: out, ...(errors.length ? { errors } : {}) };
}
