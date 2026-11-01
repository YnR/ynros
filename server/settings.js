import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.HARNESS_DATA_DIR || path.join(os.homedir(), '.ynros-harness');
const SETTINGS_FILE = () => path.join(DATA_DIR, 'settings.json');

export const PROVIDERS = ['anthropic', 'gemini', 'claudeCode'];
// Every settings section the settings page may update.
const SECTIONS = [...PROVIDERS, 'notifications', 'google', 'calendars', 'tools', 'triage'];
// Values that are write-only: stored, but never sent back to the browser.
const SECRETS = { anthropic: ['apiKey'], gemini: ['apiKey'], google: ['clientSecret'] };

export function defaultSettings() {
  return {
    defaultProvider: 'anthropic',
    anthropic: {
      apiKey: '',
      model: 'claude-sonnet-5-5',
      maxTokens: 8192,
      systemPrompt: '',
    },
    gemini: {
      apiKey: '',
      model: 'gemini-2.5-flash',
      systemPrompt: '',
    },
    claudeCode: {
      binaryPath: 'claude',
      workingDirectory: os.homedir(),
      model: '',
      permissionMode: '',
      allowedTools: '',
      systemPrompt: '',
    },
    notifications: {
      enabled: true,
      onlyWhenUnfocused: true,
    },
    google: {
      clientId: '',
      clientSecret: '',
      calendar: true,
      gmail: true,
      drive: true,
    },
    calendars: {
      // One ICS feed per line, optionally "Name | https://…/calendar.ics".
      icsFeeds: '',
    },
    tools: {
      enabled: true,
    },
    triage: {
      enabled: true,
      provider: 'auto', // auto | anthropic | gemini | claudeCode
      model: '',
    },
  };
}

const ENV_KEYS = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

let cache = null;

function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else if (k in out) {
      out[k] = v;
    }
  }
  return out;
}

export async function loadSettings() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read settings, using defaults:', e.message);
  }
  cache = merge(defaultSettings(), stored);
  return cache;
}

async function saveSettings(settings) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = SETTINGS_FILE();
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  cache = settings;
}

/** Effective API key for a provider: saved key first, then environment variable. */
export function resolveApiKey(settings, provider) {
  const saved = settings[provider]?.apiKey;
  if (saved) return { key: saved, source: 'settings' };
  const env = ENV_KEYS[provider] && process.env[ENV_KEYS[provider]];
  if (env) return { key: env, source: 'env' };
  if (provider === 'gemini' && process.env.GOOGLE_API_KEY) return { key: process.env.GOOGLE_API_KEY, source: 'env' };
  return { key: '', source: null };
}

function hint(key) {
  return key ? `…${key.slice(-4)}` : '';
}

/** Settings safe to send to the browser: API keys are never returned. */
export function publicSettings(settings) {
  const out = structuredClone(settings);
  for (const p of ['anthropic', 'gemini']) {
    const { key, source } = resolveApiKey(settings, p);
    delete out[p].apiKey;
    out[p].hasKey = Boolean(key);
    out[p].keySource = source;
    out[p].keyHint = hint(key);
  }
  if (out.google) {
    out.google.hasClientSecret = Boolean(settings.google.clientSecret);
    delete out.google.clientSecret;
  }
  out.dataDir = DATA_DIR;
  return out;
}

/**
 * Apply a partial update from the settings page. Values are coerced to the
 * type of the default. Secret fields (API keys, client secret) are only
 * replaced by a non-empty value, and removed with `clear<Field>: true`.
 */
export async function updateSettings(patch) {
  const current = structuredClone(await loadSettings());
  const defaults = defaultSettings();
  if (patch.defaultProvider && PROVIDERS.includes(patch.defaultProvider)) {
    current.defaultProvider = patch.defaultProvider;
  }
  for (const section of SECTIONS) {
    const incoming = patch[section];
    if (!incoming || typeof incoming !== 'object') continue;
    const secrets = SECRETS[section] || [];
    for (const [k, v] of Object.entries(incoming)) {
      const clear = k.match(/^clear(\w)(\w*)$/);
      if (clear) {
        const field = clear[1].toLowerCase() + clear[2];
        if (v && secrets.includes(field)) current[section][field] = '';
        continue;
      }
      if (!(k in defaults[section])) continue;
      if (secrets.includes(k)) {
        if (typeof v === 'string' && v.trim()) current[section][k] = v.trim();
        continue;
      }
      const type = typeof defaults[section][k];
      if (type === 'boolean') current[section][k] = v === true || v === 'true' || v === 'on';
      else if (type === 'number') {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) current[section][k] = Math.floor(n);
      } else current[section][k] = typeof v === 'string' ? v : String(v ?? '');
    }
  }
  await saveSettings(current);
  return current;
}

/** For tests. */
export function _resetCache() { cache = null; }
