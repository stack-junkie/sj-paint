const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paintDesktop', Object.freeze({
  openImage: () => ipcRenderer.invoke('paint:open-image'),
  saveImage: (request) => ipcRenderer.invoke('paint:save-image', request),
  openProject: () => ipcRenderer.invoke('paint:open-project'),
  saveProject: (request) => ipcRenderer.invoke('paint:save-project', request),
  setTitle: (title) => ipcRenderer.invoke('paint:set-title', title),
  print: () => ipcRenderer.invoke('paint:print'),
  confirmDiscard: () => ipcRenderer.invoke('paint:confirm-discard'),
}));
