const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: () => ipcRenderer.invoke('settings:get'),
  rate: () => ipcRenderer.invoke('rate:get'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  scan: (root, deep) => ipcRenderer.invoke('scan:start', { root, deep }),
  rescan: (dir, deep) => ipcRenderer.invoke('scan:one', { dir, deep }),
  planActions: (items) => ipcRenderer.invoke('action:plan', { items }),
  applyActions: (tokens) => ipcRenderer.invoke('action:apply', { tokens }),
  clutterScan: (dirs) => ipcRenderer.invoke('clutter:scan', { dirs }),
  copyReport: (dir) => ipcRenderer.invoke('report:copy', { dir }),
  trend: () => ipcRenderer.invoke('trend:get'),
  audit: () => ipcRenderer.invoke('audit:list'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  openFolder: (d) => ipcRenderer.invoke('open:folder', d),
  onBegin: (cb) => ipcRenderer.on('scan:begin', (_e, d) => cb(d)),
  onRepo: (cb) => ipcRenderer.on('scan:repo', (_e, d) => cb(d)),
});
