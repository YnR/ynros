import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../settings.js';

/**
 * Google OAuth for a single local user, using the user's own OAuth client
 * ("Desktop app" or "Web application" type in Google Cloud Console) and a
 * loopback redirect. Tokens are kept in DATA_DIR/google-tokens.json (0600).
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKENS_FILE = () => path.join(DATA_DIR, 'google-tokens.json');

export const SCOPES = {
  base: ['openid', 'email'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
};

const pending = new Map(); // state -> { verifier, redirectUri, created }

export function redirectUri(port) {
  return `http://localhost:${port}/api/google/callback`;
}

export function scopesFor(cfg) {
  return [...SCOPES.base, ...['calendar', 'gmail', 'drive'].filter((s) => cfg[s]).flatMap((s) => SCOPES[s])];
}

export function buildAuthUrl(settings, port) {
  const cfg = settings.google;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw Object.assign(new Error('Add your Google OAuth client ID and secret in Settings first.'), { status: 400 });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const uri = redirectUri(port);
  pending.set(state, { verifier, redirectUri: uri, created: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.created > 600_000) pending.delete(k);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: uri,
    response_type: 'code',
    scope: scopesFor(cfg).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

async function readTokens() {
  try { return JSON.parse(await fs.readFile(TOKENS_FILE(), 'utf8')); } catch { return null; }
}

async function writeTokens(t) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(TOKENS_FILE(), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export async function handleCallback(settings, { code, state, error }, fetchImpl = fetch) {
  if (error) throw new Error(`Google sign-in was cancelled (${error}).`);
  const p = pending.get(state);
  if (!p) throw new Error('This sign-in link expired. Start again from Settings.');
  pending.delete(state);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.google.clientId,
      client_secret: settings.google.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: p.verifier,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${json.error_description || json.error}`);
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
    scope: json.scope,
  };
  try {
    const info = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }).then((r) => r.json());
    tokens.email = info.email;
  } catch { /* email is cosmetic */ }
  await writeTokens(tokens);
  return tokens;
}

export async function status() {
  const t = await readTokens();
  if (!t?.refresh_token && !t?.access_token) return { connected: false };
  const scope = t.scope || '';
  return {
    connected: true,
    email: t.email || null,
    calendar: SCOPES.calendar.some((s) => scope.includes(s)),
    gmail: SCOPES.gmail.some((s) => scope.includes(s)),
    drive: SCOPES.drive.some((s) => scope.includes(s)),
  };
}

export async function disconnect(fetchImpl = fetch) {
  const t = await readTokens();
  if (t?.refresh_token || t?.access_token) {
    try {
      await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
      });
    } catch { /* still forget locally */ }
  }
  await fs.rm(TOKENS_FILE(), { force: true });
}

export async function accessToken(settings, fetchImpl = fetch) {
  const t = await readTokens();
  if (!t) throw new Error('Google is not connected. Connect it in Settings.');
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new Error('Google sign-in expired. Reconnect it in Settings.');
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.google.clientId,
      client_secret: settings.google.clientSecret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google sign-in expired (${json.error}). Reconnect it in Settings.`);
  t.access_token = json.access_token;
  t.expires_at = Date.now() + (json.expires_in - 60) * 1000;
  if (json.scope) t.scope = json.scope;
  await writeTokens(t);
  return t.access_token;
}

/** Authenticated JSON call to a Google API. */
export async function gfetch(settings, url, opts = {}, fetchImpl = fetch) {
  const token = await accessToken(settings, fetchImpl);
  const res = await fetchImpl(url, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    throw new Error(`Google API ${res.status}: ${msg}`);
  }
  return opts.raw ? res : res.json();
}
