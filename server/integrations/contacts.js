import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DATA_DIR } from '../settings.js';
import * as google from './google.js';

/**
 * People: contacts from Google Contacts and vCard (.vcf) sources (files or
 * URLs exported from iCloud, Outlook, phones…), plus a local notebook where
 * the models keep notes about people over time.
 */

const PEOPLE = 'https://people.googleapis.com/v1';
const NOTEBOOK = () => path.join(DATA_DIR, 'people.json');

/* ---------- vCard ---------- */

export function parseSources(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function unfold(t) { return t.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
function unesc(v) { return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

export function parseVcards(text) {
  const out = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = { emails: [], phones: [], source: 'vcard' }; continue; }
    if (/^END:VCARD/i.test(line)) { if (cur && (cur.name || cur.emails.length)) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
    const val = unesc(line.slice(idx + 1)).trim();
    if (key === 'FN') cur.name = val;
    else if (key === 'N' && !cur.name) cur.name = val.split(';').slice(0, 2).reverse().filter(Boolean).join(' ');
    else if (key === 'EMAIL') cur.emails.push(val);
    else if (key === 'TEL') cur.phones.push(val);
    else if (key === 'ORG') cur.organization = val.replace(/;+$/, '').replace(/;/g, ', ');
    else if (key === 'TITLE') cur.title = val;
    else if (key === 'BDAY') cur.birthday = val;
    else if (key === 'NOTE') cur.note = val;
  }
  return out;
}

const vcardCache = new Map();

async function loadVcardSource(src, fetchImpl = fetch) {
  const hit = vcardCache.get(src);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.people;
  const text = /^https?:\/\//i.test(src)
    ? await fetchImpl(src).then((r) => { if (!r.ok) throw new Error(`${src}: ${r.status}`); return r.text(); })
    : await fs.readFile(src, 'utf8');
  const people = parseVcards(text);
  vcardCache.set(src, { at: Date.now(), people });
  return people;
}

/* ---------- notebook ---------- */

async function readNotebook() {
  try { return JSON.parse(await fs.readFile(NOTEBOOK(), 'utf8')); } catch { return []; }
}

async function writeNotebook(list) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(NOTEBOOK(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

const norm = (s) => String(s || '').toLowerCase().trim();

export async function addNote({ name, email, note }) {
  if (!name && !email) throw new Error('Give a name or an email');
  if (!note) throw new Error('Note is empty');
  const list = await readNotebook();
  let p = list.find((x) => (email && x.emails?.some((e) => norm(e) === norm(email))) || (name && norm(x.name) === norm(name)));
  if (!p) {
    p = { id: crypto.randomUUID(), name: name || email, emails: email ? [email] : [], notes: [] };
    list.push(p);
  }
  if (email && !p.emails.some((e) => norm(e) === norm(email))) p.emails.push(email);
  p.notes.push({ at: new Date().toISOString(), text: String(note).slice(0, 4000) });
  await writeNotebook(list);
  return { saved: true, person: p.name, notes: p.notes.length };
}

export async function notebook() { return readNotebook(); }

/* ---------- search ---------- */

function matches(p, q) {
  if (!q) return true;
  const hay = [p.name, ...(p.emails || []), ...(p.phones || []), p.organization].map(norm).join(' ');
  return norm(q).split(/\s+/).every((w) => hay.includes(w));
}

async function googleSearch(settings, query, max) {
  const out = [];
  const read = 'names,emailAddresses,phoneNumbers,organizations,birthdays,biographies';
  // searchContacts needs a warm-up request with an empty query (per Google's docs).
  await google.gfetch(settings, `${PEOPLE}/people:searchContacts?query=&readMask=names`).catch(() => {});
  const r = await google.gfetch(settings, `${PEOPLE}/people:searchContacts?${new URLSearchParams({ query, readMask: read, pageSize: String(max) })}`);
  for (const { person: p } of r.results || []) {
    out.push({
      source: 'google',
      name: p.names?.[0]?.displayName,
      emails: (p.emailAddresses || []).map((e) => e.value),
      phones: (p.phoneNumbers || []).map((e) => e.value),
      organization: [p.organizations?.[0]?.name, p.organizations?.[0]?.title].filter(Boolean).join(', ') || undefined,
      birthday: p.birthdays?.[0]?.text || (p.birthdays?.[0]?.date ? Object.values(p.birthdays[0].date).join('-') : undefined),
      note: p.biographies?.[0]?.value,
    });
  }
  return out;
}

export async function search(settings, query, { max = 20, googleConnected = false } = {}) {
  const results = [];
  const errors = [];
  if (googleConnected && settings.google.contacts && query) {
    try { results.push(...await googleSearch(settings, query, max)); } catch (e) { errors.push(e.message); }
  }
  for (const src of parseSources(settings.contacts?.vcardSources)) {
    try { results.push(...(await loadVcardSource(src)).filter((p) => matches(p, query))); } catch (e) { errors.push(e.message); }
  }
  // Merge in notebook notes by email or name.
  const book = await readNotebook();
  for (const p of results) {
    const n = book.find((b) => b.emails?.some((e) => p.emails?.map(norm).includes(norm(e))) || norm(b.name) === norm(p.name));
    if (n) p.notes = n.notes;
  }
  for (const b of book) {
    if (!matches(b, query)) continue;
    if (results.some((p) => p.notes === b.notes)) continue;
    results.push({ source: 'notebook', name: b.name, emails: b.emails, notes: b.notes });
  }
  return { results: results.slice(0, max), ...(errors.length ? { errors } : {}) };
}
