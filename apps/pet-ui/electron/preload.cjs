const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petdBootstrap', {
  read: () => ipcRenderer.invoke('petd:bootstrap'),
  setMemoryWorkspace: (workspace) => ipcRenderer.invoke('memory:set-workspace', workspace),
  getBlobThumbnail: (meta) => ipcRenderer.invoke('blob:thumbnail', meta),
  getBlobFileUrl: (meta) => ipcRenderer.invoke('blob:file-url', meta),
  showChat: () => ipcRenderer.invoke('pet:show-chat'),
  showPetMenu: () => ipcRenderer.invoke('pet:show-menu'),
  startDrag: () => ipcRenderer.invoke('pet:drag-start'),
  endDrag: () => ipcRenderer.invoke('pet:drag-end'),
  resizePet: (height) => ipcRenderer.invoke('pet:resize', height),
  updatePetHitRegions: (regions) => ipcRenderer.send('pet:hit-regions', regions),
  openApprovalWindow: () => ipcRenderer.invoke('pet:approval-open'),
  closeApprovalWindow: () => ipcRenderer.invoke('pet:approval-close'),
});
