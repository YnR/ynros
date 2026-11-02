// Desktop app: runs the harness server in-process and shows it in a window,
// with native notifications. The same UI also works in any browser at
// http://localhost:4317 while the app (or `npm start`) is running.
import { app, BrowserWindow, ipcMain, Notification, shell, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, startAutomations, rearmHolds, importHistoryOnStart } from '../server/index.js';

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
  rearmHolds().catch(() => {});
  startAutomations();
  importHistoryOnStart();
  return 'started';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: 'Harness',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f7f5',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links to other sites open in the default browser; the window stays on the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
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

ipcMain.on('harness:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on('harness:set-theme', (_e, theme) => {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try {
    await ensureServer();
  } catch (e) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('Harness could not start', `${e.message}\n\nIs something else using port ${PORT}? Set PORT to use another one.`);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

// Keep running on macOS so automations and notifications continue; quit elsewhere.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
