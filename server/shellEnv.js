// Apps opened from Finder or the Dock get a bare PATH (/usr/bin:/bin:…), so the
// `claude` CLI installed by npm, Homebrew or the native installer isn't found.
// Load the PATH your login shell sets, once, and find the claude binary, so the
// harness runs the same Claude Code you use in a terminal: same sign-in, same
// MCP servers, same settings.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMON_BIN_DIRS = [
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function loginShellPath(timeoutMs = 4000) {
  if (process.platform === 'win32') return Promise.resolve('');
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    // -i -l loads .zprofile/.zshrc (nvm, Homebrew, ~/.local/bin…). Markers skip any banner output.
    execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: timeoutMs, env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      const m = String(stdout || '').match(/__PATH__(.*)__PATH__/);
      resolve(m ? m[1] : '');
    });
  });
}

export function mergePath(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const p of String(list || '').split(path.delimiter)) {
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out.join(path.delimiter);
}

export function findOnPath(name, PATH = process.env.PATH) {
  for (const dir of String(PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

let ready = null;
let claudePath = null;

/** Fix up process.env.PATH once. Safe to call many times. */
export function loadShellEnv() {
  ready ||= (async () => {
    const shellPath = await loginShellPath();
    process.env.PATH = mergePath(shellPath, process.env.PATH, COMMON_BIN_DIRS.join(path.delimiter));
    claudePath = findOnPath('claude');
    return { claude: claudePath };
  })();
  return ready;
}

/** Absolute path to the claude CLI, or null if it isn't installed. */
export const claudeBinary = () => claudePath;

/** The binary to spawn: an explicit setting wins, then what was found, then plain "claude". */
export function resolveClaudeBinary(setting) {
  if (setting && setting !== 'claude') return setting;
  return claudePath || 'claude';
}
