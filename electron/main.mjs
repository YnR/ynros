// Desktop app: runs the harness server in-process and shows it in a window,
// with native notifications. The same UI also works in any browser at
// http://localhost:4317 while the app (or `npm start`) is running.
import { app, BrowserWindow, ipcMain, Notification, shell, nativeTheme, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, startBackground } from '../server/index.js';
import { loadShellEnv } from '../server/shellEnv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;
const ORIGIN = `http://localhost:${PORT}`;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.ynros.harness');

/** Start the server, or reuse one that is already running (e.g. `npm start`). */
async function ensureServer() {
  try {
    const r = await fetch(`${ORIGIN}/api/settings`);
    if (r.ok) return 'reused';
  } catch { /* not running */ }
  await new Promise((resolve, reject) => {
    const server = createServer({ port: PORT });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  startBackground();
  return 'started';
}

// Black neon logo on a dark system theme, light logo on a light one.
const iconPath = () => path.join(here, '..', 'public', 'icons', nativeTheme.shouldUseDarkColors ? 'logo-512.png' : 'logo-light-512.png');
function applyIcon() {
  if (process.platform === 'darwin') app.dock?.setIcon(iconPath());
  else for (const w of BrowserWindow.getAllWindows()) w.setIcon(iconPath());
}

const windowOptions = () => ({
  icon: iconPath(),
  minWidth: 520,
  minHeight: 400,
  title: 'Harness',
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f7f5',
  webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
});

/** Same-origin pages (shift-click "open alone") get their own app window; other links go to the browser. */
function guard(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) {
      const w = new BrowserWindow({ ...windowOptions(), width: 900, height: 860 });
      guard(w.webContents);
      w.loadURL(url);
      return { action: 'deny' };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: 'Harness',
    icon: iconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f7f5',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  guard(win.webContents);
  win.loadURL(ORIGIN);
  win.on('closed', () => { win = null; });
}

ipcMain.on('harness:notify', (_e, { title, body, hash }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Harness'), body: String(body || '').slice(0, 300) });
  n.on('click', () => {
    if (!win) createWindow();
    win.show();
    win.focus();
    if (hash) win.webContents.send('harness:navigate', hash);
  });
  n.show();
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    if (process.platform === 'darwin') app.dock?.bounce('informational');
  }
});

ipcMain.on('harness:badge', (_e, n) => {
  // Unread replies plus chats waiting for an answer.
  app.setBadgeCount?.(Math.max(0, Math.min(999, n)));
});

ipcMain.on('harness:open-window', (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith(ORIGIN)) return;
  const w = new BrowserWindow({ ...windowOptions(), width: 900, height: 860 });
  guard(w.webContents);
  w.loadURL(url);
});

ipcMain.handle('harness:pick-files', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('harness:version', () => app.getVersion());

ipcMain.on('harness:open-at-login', (_e, on) => {
  try { app.setLoginItemSettings({ openAtLogin: Boolean(on) }); } catch { /* not supported here */ }
});

// Restart (to load new code) once no chat is running.
ipcMain.on('harness:restart-when-idle', () => {
  const check = async () => {
    try {
      const list = await (await fetch(`${ORIGIN}/api/conversations`)).json();
      if (list.some((c) => c.running)) { setTimeout(check, 5000); return; }
    } catch { /* server gone: restart anyway */ }
    app.relaunch();
    app.exit(0);
  };
  check();
});

ipcMain.on('harness:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on('harness:set-theme', (_e, theme) => {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try {
    await loadShellEnv();
    await ensureServer();
  } catch (e) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('Harness could not start', `${e.message}\n\nIs something else using port ${PORT}? Set PORT to use another one.`);
    app.quit();
    return;
  }
  applyIcon();
  nativeTheme.on('updated', applyIcon);
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

// Keep running on macOS so automations and notifications continue; quit elsewhere.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
