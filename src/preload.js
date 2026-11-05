const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: () => ipcRenderer.invoke('settings:get'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  scan: (root, deep) => ipcRenderer.invoke('scan:start', { root, deep }),
  rescan: (dir, deep) => ipcRenderer.invoke('scan:one', { dir, deep }),
  action: (dir, action) => ipcRenderer.invoke('action:run', { dir, action }),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  openFolder: (d) => ipcRenderer.invoke('open:folder', d),
  onBegin: (cb) => ipcRenderer.on('scan:begin', (_e, d) => cb(d)),
  onRepo: (cb) => ipcRenderer.on('scan:repo', (_e, d) => cb(d)),
});
