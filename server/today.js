import * as store from './store.js';
import * as runs from './runs.js';
import { availableTools, runTool } from './tools.js';
import * as feeds from './integrations/feeds.js';

/**
 * The home page: what needs attention today. Built from data, not a model, so
 * it loads fast and costs nothing. The "Brief me" button starts a normal chat.
 */
export async function today(settings) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const { tools, googleStatus } = await availableTools(settings);
  const has = (n) => tools.some((t) => t.name === n);
  const out = { date: start.toISOString(), calendar: null, mail: null, reading: null, attention: [], working: [], recent: [], sources: {} };

  const jobs = [];
  if (has('list_calendar_events')) {
    jobs.push(runTool('list_calendar_events', { time_min: start.toISOString(), time_max: end.toISOString(), max_results: 50 }, settings)
      .then((r) => { out.calendar = r.events; if (r.errors) out.sources.calendarErrors = r.errors; })
      .catch((e) => { out.sources.calendarError = e.message; }));
  }
  if (has('gmail_search')) {
    jobs.push(runTool('gmail_search', { query: 'is:unread (is:important OR is:starred) newer_than:3d -category:promotions -category:social', max_results: 8 }, settings)
      .then((r) => { out.mail = r.results; })
      .catch((e) => { out.sources.mailError = e.message; }));
  }
  out.sources.google = Boolean(googleStatus.connected);
  if (feeds.parseSources(settings).length) {
    jobs.push(feeds.recentItems(settings, { sinceHours: 36, perSource: 5 })
      .then((r) => { out.reading = r.sources; if (r.errors) out.sources.feedErrors = r.errors; })
      .catch((e) => { out.sources.feedError = e.message; }));
  }

  const active = new Map(runs.activeSummary().map((r) => [r.conversationId, r]));
  const dayAgo = Date.now() - 86_400_000;
  for (const c of await store.listConversations()) {
    const run = active.get(c.id);
    if (run) {
      out.working.push({ id: c.id, title: c.title, subagents: run.subagents.filter((s) => s.status === 'running').length });
      const conv = run.conv;
      const ask = (conv.queue || []).find((q) => q.triage?.decision === 'interrupt' && !q.triage.dismissed);
      if (ask) out.attention.push({ id: c.id, title: c.title, kind: 'interrupt', text: `Wants to interrupt: ${ask.text.slice(0, 120)}` });
      continue;
    }
    if (new Date(c.updatedAt).getTime() < dayAgo) continue;
    const conv = await store.getConversation(c.id);
    if (!conv) continue;
    const last = conv.messages.at(-1);
    if (conv.quotaHold) {
      out.attention.push({ id: c.id, title: c.title, kind: 'quota', text: `${conv.quotaHold.label} is out of quota; ${conv.queue?.length || 0} message(s) waiting` });
    } else if (conv.queuePaused && conv.queue?.length) {
      out.attention.push({ id: c.id, title: c.title, kind: 'queue', text: `${conv.queue.length} queued message(s) paused after Stop` });
    } else if (last?.error) {
      out.attention.push({ id: c.id, title: c.title, kind: 'error', text: last.error.slice(0, 160) });
    } else if (last?.role === 'assistant') {
      out.recent.push({ id: c.id, title: c.title, at: c.updatedAt, preview: last.content.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  out.recent = out.recent.slice(0, 6);
  await Promise.all(jobs);
  return out;
}

export const BRIEF_PROMPT = `Give me my brief for today. Use the tools you have: check today's and tomorrow morning's calendar, important unread email, my news and feed sources, and anything time-sensitive. Then tell me, in order of priority:
1. What I must not miss today (meetings, deadlines, replies people are waiting for).
2. What I should prepare for.
3. What's worth reading from my sources today (one line each, with links).
4. Anything I can safely ignore.
Keep it short. If a tool is not connected, say so in one line and carry on.`;
