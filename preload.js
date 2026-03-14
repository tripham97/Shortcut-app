const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  search: (query) => ipcRenderer.send('perform-search', query),
  onFocusInput: (callback) => ipcRenderer.on('focus-input', callback),
  searchApps: (query) => ipcRenderer.invoke('search-apps', query),
  launchApp: (appEntry) => ipcRenderer.invoke('launch-app', appEntry),
  setWindowHeight: (height) => ipcRenderer.send('set-window-height', height),
});
