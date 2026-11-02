// The only bridge between the page and Electron: notifications, opening links
// in the default browser, and following the theme.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessDesktop', {
  notify: (n) => ipcRenderer.send('harness:notify', n),
  openExternal: (url) => ipcRenderer.send('harness:open-external', url),
  setTheme: (theme) => ipcRenderer.send('harness:set-theme', theme),
  onNavigate: (fn) => ipcRenderer.on('harness:navigate', (_e, hash) => fn(hash)),
});
