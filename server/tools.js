import * as google from './integrations/google.js';
import * as ics from './integrations/ics.js';
import * as skills from './integrations/skills.js';
import * as files from './files.js';
import * as contacts from './integrations/contacts.js';
import fsp from 'node:fs/promises';
import pathMod from 'node:path';

/**
 * Tools the models can call: Google Calendar, Gmail, Drive, ICS calendars and
 * skills. The same definitions back the Anthropic and Gemini tool loops and
 * the MCP server that Claude Code uses.
 *
 * Nothing here sends email or invites: Gmail only creates drafts, and new
 * calendar events are created with sendUpdates=none.
 */

const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const MAX_TEXT = 60_000;

const clip = (s, n = MAX_TEXT) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);
const obj = (properties, required = []) => ({ type: 'object', properties, required });

function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mailBody(payload) {
  let plain = '';
  let html = '';
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decodeB64Url(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decodeB64Url(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return plain || htmlToText(html);
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function toRfc3339(v, fallback) {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${v}`);
  return d.toISOString();
}

function encodeHeader(s) {
  // RFC 2047 for non-ASCII subjects.
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
}

export const TOOLS = [
  {
    name: 'list_calendars',
    group: 'calendar',
    description: 'List the calendars the user has connected (Google calendars and ICS feeds). Returns ids to use with list_calendar_events.',
    schema: obj({}),
    async run(_args, { settings, googleStatus }) {
      const out = [];
      if (googleStatus.calendar && settings.google.calendar) {
        const r = await google.gfetch(settings, `${CAL}/users/me/calendarList?maxResults=100`);
        for (const c of r.items || []) out.push({ id: c.id, name: c.summary, primary: Boolean(c.primary), source: 'google', writable: ['owner', 'writer'].includes(c.accessRole) });
      }
      for (const f of ics.parseFeeds(settings.calendars.icsFeeds)) out.push({ id: f.id, name: f.name, source: 'ics', writable: false });
      return out;
    },
  },
  {
    name: 'list_calendar_events',
    group: 'calendar',
    description: 'List events in a time range from one calendar, or from all connected calendars when calendar_id is omitted. Times are ISO 8601. Defaults to the next 7 days.',
    schema: obj({
      calendar_id: { type: 'string', description: 'Id from list_calendars. Omit for all calendars.' },
      time_min: { type: 'string', description: 'Start of range, ISO 8601. Default: now.' },
      time_max: { type: 'string', description: 'End of range, ISO 8601. Default: 7 days after time_min.' },
      query: { type: 'string', description: 'Optional text to match in event titles/descriptions.' },
      max_results: { type: 'integer', description: 'Default 50.' },
    }),
    async run(args, { settings, googleStatus }) {
      const timeMin = toRfc3339(args.time_min, new Date().toISOString());
      const timeMax = toRfc3339(args.time_max, new Date(new Date(timeMin).getTime() + 7 * 86_400_000).toISOString());
      const max = Math.min(Number(args.max_results) || 50, 250);
      const q = (args.query || '').toLowerCase();
      const out = [];
      const errors = [];
      const feeds = ics.parseFeeds(settings.calendars.icsFeeds);
      const wantGoogle = googleStatus.calendar && settings.google.calendar && (!args.calendar_id || !args.calendar_id.startsWith('ics:'));
      if (wantGoogle) {
        const ids = args.calendar_id ? [args.calendar_id] : ['primary'];
        for (const id of ids) {
          const p = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) });
          if (args.query) p.set('q', args.query);
          try {
            const r = await google.gfetch(settings, `${CAL}/calendars/${encodeURIComponent(id)}/events?${p}`);
            for (const e of r.items || []) {
              out.push({
                calendar: id, id: e.id, title: e.summary || '(no title)',
                start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
                allDay: Boolean(e.start?.date), location: e.location, description: clip(e.description, 500),
                attendees: e.attendees?.map((a) => a.email), link: e.htmlLink,
              });
            }
          } catch (e) { errors.push(e.message); }
        }
      }
      for (const f of feeds) {
        if (args.calendar_id && args.calendar_id !== f.id) continue;
        try {
          const events = ics.expand(await ics.loadFeed(f), new Date(timeMin), new Date(timeMax));
          for (const e of events) {
            if (q && !`${e.summary} ${e.description}`.toLowerCase().includes(q)) continue;
            out.push({
              calendar: f.name, id: e.uid, title: e.summary || '(no title)',
              start: e.allDay ? e.start.toDateString() : e.start.toISOString(),
              end: e.allDay ? e.end.toDateString() : e.end.toISOString(),
              allDay: e.allDay, location: e.location, description: clip(e.description, 500),
            });
          }
        } catch (e) { errors.push(e.message); }
      }
      out.sort((a, b) => new Date(a.start) - new Date(b.start));
      return { timeMin, timeMax, events: out.slice(0, max), ...(errors.length ? { errors } : {}) };
    },
  },
  {
    name: 'create_calendar_event',
    group: 'calendar',
    needsGoogle: 'calendar',
    description: 'Create an event on a Google calendar. Guests are added but NOT emailed. Confirm details with the user before calling.',
    schema: obj({
      calendar_id: { type: 'string', description: 'Default: primary.' },
      title: { type: 'string' },
      start: { type: 'string', description: 'ISO 8601 date-time, or YYYY-MM-DD for all-day.' },
      end: { type: 'string', description: 'ISO 8601 date-time, or YYYY-MM-DD (exclusive) for all-day.' },
      time_zone: { type: 'string', description: 'IANA zone, e.g. Europe/Paris. Default: the calendar\'s zone.' },
      description: { type: 'string' },
      location: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses.' },
    }, ['title', 'start', 'end']),
    async run(args, { settings }) {
      const when = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: toRfc3339(v), ...(args.time_zone ? { timeZone: args.time_zone } : {}) });
      const body = {
        summary: args.title, start: when(args.start), end: when(args.end),
        description: args.description, location: args.location,
        attendees: args.attendees?.map((email) => ({ email })),
      };
      const id = encodeURIComponent(args.calendar_id || 'primary');
      const e = await google.gfetch(settings, `${CAL}/calendars/${id}/events?sendUpdates=none`, { method: 'POST', body: JSON.stringify(body) });
      return { created: true, id: e.id, link: e.htmlLink, start: e.start, end: e.end };
    },
  },
  {
    name: 'gmail_search',
    group: 'gmail',
    needsGoogle: 'gmail',
    description: 'Search the user\'s Gmail with Gmail search syntax (e.g. "from:alice newer_than:7d", "is:unread label:inbox"). Returns message ids, senders, subjects and snippets.',
    schema: obj({
      query: { type: 'string' },
      max_results: { type: 'integer', description: 'Default 10, max 50.' },
    }, ['query']),
    async run(args, { settings }) {
      const p = new URLSearchParams({ q: args.query, maxResults: String(Math.min(Number(args.max_results) || 10, 50)) });
      const r = await google.gfetch(settings, `${GMAIL}/messages?${p}`);
      const out = [];
      for (const m of r.messages || []) {
        const full = await google.gfetch(settings, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`);
        out.push({
          id: m.id, threadId: m.threadId, from: header(full, 'From'), to: header(full, 'To'),
          subject: header(full, 'Subject'), date: header(full, 'Date'), snippet: full.snippet,
          unread: (full.labelIds || []).includes('UNREAD'),
        });
      }
      return { results: out, estimatedTotal: r.resultSizeEstimate };
    },
  },
  {
    name: 'gmail_read',
    group: 'gmail',
    needsGoogle: 'gmail',
    description: 'Read one email (headers and plain-text body) by message id from gmail_search.',
    schema: obj({ message_id: { type: 'string' } }, ['message_id']),
    async run(args, { settings }) {
      const m = await google.gfetch(settings, `${GMAIL}/messages/${encodeURIComponent(args.message_id)}?format=full`);
      return {
        id: m.id, threadId: m.threadId,
        from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'),
        subject: header(m, 'Subject'), date: header(m, 'Date'), messageId: header(m, 'Message-ID'),
        body: clip(mailBody(m.payload), 30_000),
      };
    },
  },
  {
    name: 'gmail_create_draft',
    group: 'gmail',
    needsGoogle: 'gmail',
    description: 'Create a Gmail draft (it is NOT sent; the user reviews and sends it from Gmail). Pass reply_to_message_id to draft a reply in the same thread.',
    schema: obj({
      to: { type: 'string', description: 'Comma-separated addresses.' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain text.' },
      cc: { type: 'string' },
      reply_to_message_id: { type: 'string', description: 'Gmail message id to reply to.' },
    }, ['to', 'subject', 'body']),
    async run(args, { settings }) {
      const headers = [`To: ${args.to}`, `Subject: ${encodeHeader(args.subject)}`, 'Content-Type: text/plain; charset=UTF-8', 'MIME-Version: 1.0'];
      if (args.cc) headers.push(`Cc: ${args.cc}`);
      let threadId;
      if (args.reply_to_message_id) {
        const orig = await google.gfetch(settings, `${GMAIL}/messages/${encodeURIComponent(args.reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID`);
        threadId = orig.threadId;
        const mid = header(orig, 'Message-ID');
        if (mid) headers.push(`In-Reply-To: ${mid}`, `References: ${mid}`);
      }
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${args.body}`).toString('base64url');
      const d = await google.gfetch(settings, `${GMAIL}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw, threadId } }) });
      return { draftCreated: true, draftId: d.id, note: 'Saved to Gmail Drafts. Not sent.' };
    },
  },
  {
    name: 'drive_search',
    group: 'drive',
    needsGoogle: 'drive',
    description: 'Search Google Drive files by name and content. Returns file ids, names, types and links.',
    schema: obj({
      query: { type: 'string', description: 'Words to look for.' },
      max_results: { type: 'integer', description: 'Default 10, max 50.' },
    }, ['query']),
    async run(args, { settings }) {
      const esc = String(args.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const p = new URLSearchParams({
        q: `(name contains '${esc}' or fullText contains '${esc}') and trashed = false`,
        pageSize: String(Math.min(Number(args.max_results) || 10, 50)),
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))',
        orderBy: 'modifiedTime desc',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      const r = await google.gfetch(settings, `${DRIVE}/files?${p}`);
      return (r.files || []).map((f) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink, owner: f.owners?.[0]?.displayName }));
    },
  },
  {
    name: 'drive_read',
    group: 'drive',
    needsGoogle: 'drive',
    description: 'Read the text of a Drive file by id: Google Docs/Slides as text, Sheets as CSV (first sheet), and plain-text files.',
    schema: obj({ file_id: { type: 'string' } }, ['file_id']),
    async run(args, { settings }) {
      const id = encodeURIComponent(args.file_id);
      const meta = await google.gfetch(settings, `${DRIVE}/files/${id}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`);
      const exportAs = {
        'application/vnd.google-apps.document': 'text/plain',
        'application/vnd.google-apps.presentation': 'text/plain',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
      }[meta.mimeType];
      let res;
      if (exportAs) res = await google.gfetch(settings, `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`, { raw: true });
      else if (/^text\/|json|xml|csv|markdown/.test(meta.mimeType)) res = await google.gfetch(settings, `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, { raw: true });
      else return { ...meta, note: 'This file type cannot be read as text. Open it with the link.' };
      return { name: meta.name, type: meta.mimeType, link: meta.webViewLink, text: clip(await res.text()) };
    },
  },
  {
    name: 'find_people',
    group: 'people',
    description: 'Look up people in the user\'s contacts (Google Contacts, vCard files) and in the people notebook. Returns names, emails, phones, organization and saved notes. Use it to resolve "who is X" or to find an email address before drafting mail or invites.',
    schema: obj({
      query: { type: 'string', description: 'Name, email, company or phone. Empty lists notebook entries.' },
      max_results: { type: 'integer', description: 'Default 20.' },
    }),
    async run(args, { settings, googleStatus }) {
      return contacts.search(settings, args.query || '', {
        max: Math.min(Number(args.max_results) || 20, 100),
        googleConnected: Boolean(googleStatus.contacts),
      });
    },
  },
  {
    name: 'remember_about_person',
    group: 'people',
    description: 'Save a short note about a person in the local people notebook (e.g. preferences, context from a meeting, how they relate to the user). Only save what the user would want remembered.',
    schema: obj({
      name: { type: 'string' },
      email: { type: 'string' },
      note: { type: 'string' },
    }, ['note']),
    async run(args) {
      return contacts.addNote(args);
    },
  },
  {
    name: 'project_list_files',
    group: 'project',
    description: 'List files in the current project folder (optionally filtered by a substring).',
    schema: obj({ filter: { type: 'string' } }),
    async run(args, { project }) {
      return files.listAllFiles(project.path, { query: args.filter || '', limit: 500 });
    },
  },
  {
    name: 'project_read_file',
    group: 'project',
    description: 'Read a text file from the current project folder. Paths are relative to the project.',
    schema: obj({ path: { type: 'string' } }, ['path']),
    async run(args, { project }) {
      const { abs, rel } = await files.resolveInside(project.path, args.path);
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) return { path: rel, note: 'Binary file, not shown.' };
      return { path: rel, text: clip(buf.toString('utf8')) };
    },
  },
  {
    name: 'project_write_file',
    group: 'project',
    description: 'Create or overwrite a text file in the current project folder. Put deliverables in outputs/. Paths are relative to the project.',
    schema: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    async run(args, { project }) {
      const { abs, rel } = await files.resolveInside(project.path, args.path);
      if (rel === '' || rel.startsWith('..')) throw new Error('Invalid path');
      await fsp.mkdir(pathMod.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(args.content));
      return { saved: rel, bytes: Buffer.byteLength(String(args.content)) };
    },
  },
  {
    name: 'load_skill',
    group: 'skills',
    description: 'Load the full instructions of a skill by name. Call this before doing a task that one of the listed skills covers.',
    schema: obj({ name: { type: 'string' } }, ['name']),
    async run(args, { settings }) {
      const s = await skills.loadSkill(settings, args.name);
      return { name: s.name, path: s.path, instructions: s.text };
    },
  },
];

/** Which tools are usable right now, given settings and connections. */
export async function availableTools(settings, { forClaudeCode = false, project = null } = {}) {
  if (settings.tools?.enabled === false) return { tools: [], skills: [], googleStatus: { connected: false } };
  const googleStatus = await google.status();
  const hasFeeds = ics.parseFeeds(settings.calendars.icsFeeds).length > 0;
  const hasGoogleCal = googleStatus.calendar && settings.google.calendar;
  const skillList = forClaudeCode ? [] : await skills.listSkills(settings);
  const tools = TOOLS.filter((t) => {
    if (t.group === 'skills') return !forClaudeCode && skillList.length > 0; // Claude Code has its own skills
    if (t.group === 'people') {
      const anySource = (googleStatus.contacts && settings.google.contacts) || contacts.parseSources(settings.contacts?.vcardSources).length;
      return t.name === 'remember_about_person' ? settings.contacts?.notebook !== false : Boolean(anySource) || settings.contacts?.notebook !== false;
    }
    if (t.group === 'project') return !forClaudeCode && Boolean(project); // Claude Code edits files itself
    if (t.needsGoogle) return googleStatus[t.needsGoogle] && settings.google[t.needsGoogle];
    if (t.group === 'calendar') return hasGoogleCal || hasFeeds;
    return true;
  });
  return { tools, skills: skillList, googleStatus };
}

export async function runTool(name, args, settings, { project = null } = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  if (tool.group === 'project' && !project) throw new Error('This chat is not in a project');
  const googleStatus = await google.status();
  return tool.run(args || {}, { settings, googleStatus, project });
}

/** Extra system text so API models know about skills and the current date. */
export function toolSystemNote(skillList, { project = null, instructions = '' } = {}) {
  const lines = [`Current date and time: ${new Date().toString()}.`];
  if (project) {
    lines.push('', `You are working in the project "${project.name}" (folder: ${project.path}). Use the project_* tools to read and write its files, and save deliverables in outputs/.`);
    if (instructions) lines.push('', '<project_instructions source="CLAUDE.md">', instructions.trim(), '</project_instructions>');
  }
  if (skillList.length) {
    lines.push('', 'Skills are available. When a task matches one, call load_skill with its name first and follow its instructions:',
      ...skillList.map((s) => `- ${s.name}: ${s.description}`));
  }
  return lines.join('\n');
}
