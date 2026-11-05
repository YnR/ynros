import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.HARNESS_DATA_DIR || path.join(os.homedir(), '.ynros-harness');
const SETTINGS_FILE = () => path.join(DATA_DIR, 'settings.json');

export const PROVIDERS = ['anthropic', 'gemini', 'claudeCode'];
// Every settings section the settings page may update.
const SECTIONS = [...PROVIDERS, 'notifications', 'google', 'calendars', 'tools', 'triage', 'files', 'projects', 'contacts', 'quota', 'routing', 'appearance', 'sources', 'homeAssistant', 'history', 'permissions', 'desktop', 'briefing', 'migrations'];
// Values that are write-only: stored, but never sent back to the browser.
const SECRETS = { anthropic: ['apiKey'], gemini: ['apiKey'], google: ['clientSecret'], homeAssistant: ['token'] };

export function defaultSettings() {
  return {
    defaultProvider: 'claudeCode',
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
      // Show Claude Code's permission prompts in the chat (Allow / Deny) instead of denying them.
      askInChat: true,
      // Claude in Chrome: let Claude Code act in your Chrome browser (--chrome).
      chrome: false,
      // Pass ANTHROPIC_API_KEY through to Claude Code (bills the API). Off = your Claude login.
      useApiKey: false,
    },
    sources: {
      // Feeds for the Today view, one per line: "Name | https://…/feed.xml" or just the URL.
      feeds: '',
      // News topics (comma or line separated), fetched from Google News.
      newsTopics: '',
      newsRegion: 'en-US:US',
    },
    history: {
      // Import past Claude Code and Gemini CLI chats from this computer when the app starts.
      autoImport: true,
      // Register the folders those chats ran in as projects (nothing is written into them).
      createProjects: true,
      claudeCodeDir: '', // default ~/.claude/projects
      geminiDir: '', // default ~/.gemini/tmp
    },
    homeAssistant: {
      url: '', // e.g. http://homeassistant.local:8123
      token: '', // long-lived access token
      locationEntity: '', // person.you or device_tracker.your_phone
      notifyService: '', // notify.mobile_app_your_phone
    },
    appearance: {
      theme: 'system', // system | light | dark
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
      contacts: true,
    },
    contacts: {
      // vCard sources, one per line: a .vcf file path or URL.
      vcardSources: '',
      notebook: true,
    },
    calendars: {
      // One ICS feed per line, optionally "Name | https://…/calendar.ics".
      icsFeeds: '',
    },
    tools: {
      enabled: true,
    },
    projects: {
      // Where new projects are created and existing ones are found. Empty = ~/src.
      hostFolder: '',
      lastProjectId: '',
      // Chats shown per project in the sidebar before "Show more".
      chatsPerGroup: 3,
    },
    permissions: {
      // Allow non-destructive git commands (status, diff, log, add, commit…) without asking.
      safeGit: true,
    },
    briefing: {
      // Daily briefing from mail and calendar, saved to dir as JSON + HTML per day.
      enabled: true,
      dir: '~/.ynros/briefings',
      hour: 6, // first run of the day happens after this local hour
      refreshHours: 3, // check again for anything new this often
      provider: '', // empty = same choice as triage
      model: '',
      // Where mail and calendar come from: auto (harness Google sign-in, else your
      // local Claude Code's claude.ai Gmail/Calendar connectors), harness, or claudeCode.
      source: 'auto',
      fetchModel: 'sonnet',
    },
    migrations: {
      // One-time switch of the default provider to your local Claude Code.
      localClaudeCode: false,
    },
    desktop: {
      // Desktop app: open at login.
      openAtLogin: false,
    },
    routing: {
      // "Auto" model: a small model picks small / medium / large per message.
      enabled: true,
      suggestNewChat: true,
      // Suggest a smaller model when a message looks simple for the one in use.
      suggestSmaller: true,
      // Optional overrides of the model used for each tier.
      anthropic: { small: '', medium: '', large: '' },
      gemini: { small: '', medium: '', large: '' },
      claudeCode: { small: '', medium: '', large: '' },
    },
    quota: {
      // Keep this share of each provider's window for new instructions:
      // queued and resumed work waits once usage passes 100 - reservePercent.
      reservePercent: 5,
      // Optional token budgets per rolling window (0 = rely on the provider's own limits).
      anthropic: { budget: 0, windowHours: 24 },
      gemini: { budget: 0, windowHours: 24 },
      claudeCode: { budget: 0, windowHours: 5 },
    },
    files: {
      // Folder for the Markdown viewer/editor. Empty = Claude Code working directory.
      root: '',
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
  if (out.homeAssistant) {
    out.homeAssistant.hasToken = Boolean(settings.homeAssistant.token);
    delete out.homeAssistant.token;
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
      if (type === 'object' && v && typeof v === 'object') {
        for (const [kk, vv] of Object.entries(v)) {
          if (!(kk in defaults[section][k])) continue;
          if (typeof defaults[section][k][kk] === 'string') { current[section][k][kk] = String(vv ?? ''); continue; }
          const n = Number(vv);
          if (Number.isFinite(n) && n >= 0) current[section][k][kk] = n;
        }
        continue;
      }
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
