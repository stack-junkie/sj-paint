const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paintDesktop', Object.freeze({
  listFonts: () => ipcRenderer.invoke('paint:list-fonts'),
  localAiStatus: () => ipcRenderer.invoke('paint:local-ai-status'),
  localAiProbe: request => ipcRenderer.invoke('paint:local-ai-probe', request),
  localAiRun: request => ipcRenderer.invoke('paint:local-ai-run', request),
  localAiCancel: request => ipcRenderer.invoke('paint:local-ai-cancel', request),
  openImage: (request) => ipcRenderer.invoke('paint:open-image', request),
  saveImage: (request) => ipcRenderer.invoke('paint:save-image', request),
  openProject: () => ipcRenderer.invoke('paint:open-project'),
  saveProject: (request) => ipcRenderer.invoke('paint:save-project', request),
  savePaint: (request) => ipcRenderer.invoke('paint:save-paint', request),
  setTitle: (title) => ipcRenderer.invoke('paint:set-title', title),
  print: () => ipcRenderer.invoke('paint:print'),
  confirmSaveChanges: () => ipcRenderer.invoke('paint:confirm-save-changes'),
  onCloseRequested: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A close request callback is required.');
    const listener = (_event, requestId) => {
      if (typeof requestId === 'string') callback(requestId);
    };
    ipcRenderer.on('paint:close-requested', listener);
    return () => ipcRenderer.removeListener('paint:close-requested', listener);
  },
  finishClose: (request) => ipcRenderer.invoke('paint:finish-close', request),
}));
