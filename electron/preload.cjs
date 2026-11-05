// The only bridge between the page and Electron: notifications, opening links
// in the default browser, the theme, the dock badge, extra windows, the system
// file picker, opening at login and restarting when idle.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessDesktop', {
  notify: (n) => ipcRenderer.send('harness:notify', n),
  openExternal: (url) => ipcRenderer.send('harness:open-external', url),
  setTheme: (theme) => ipcRenderer.send('harness:set-theme', theme),
  onNavigate: (fn) => ipcRenderer.on('harness:navigate', (_e, hash) => fn(hash)),
  setBadge: (n) => ipcRenderer.send('harness:badge', Number(n) || 0),
  openWindow: (url) => ipcRenderer.send('harness:open-window', url),
  pickFiles: () => ipcRenderer.invoke('harness:pick-files'),
  setOpenAtLogin: (on) => ipcRenderer.send('harness:open-at-login', Boolean(on)),
  restartWhenIdle: () => ipcRenderer.send('harness:restart-when-idle'),
  version: () => ipcRenderer.invoke('harness:version'),
});
