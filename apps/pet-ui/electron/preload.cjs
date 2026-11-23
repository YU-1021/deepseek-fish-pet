const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petdBootstrap', {
  read: () => ipcRenderer.invoke('petd:bootstrap'),
  setMemoryWorkspace: (workspace) => ipcRenderer.invoke('memory:set-workspace', workspace),
  getBlobThumbnail: (meta) => ipcRenderer.invoke('blob:thumbnail', meta),
  getBlobFileUrl: (meta) => ipcRenderer.invoke('blob:file-url', meta),
  readGameCapture: (filePath) => ipcRenderer.invoke('game:read-capture', filePath),
  showChat: () => ipcRenderer.invoke('pet:show-chat'),
  showPetMenu: () => ipcRenderer.invoke('pet:show-menu'),
  startDrag: () => ipcRenderer.invoke('pet:drag-start'),
  endDrag: () => ipcRenderer.invoke('pet:drag-end'),
  resizePet: (height) => ipcRenderer.invoke('pet:resize', height),
  updatePetHitRegions: (regions) => ipcRenderer.send('pet:hit-regions', regions),
  openApprovalWindow: () => ipcRenderer.invoke('pet:approval-open'),
  closeApprovalWindow: () => ipcRenderer.invoke('pet:approval-close'),
  openCuaPermissionWindow: (permission) => ipcRenderer.invoke('pet:cua-permission-open', permission),
  readCuaPermission: () => ipcRenderer.invoke('pet:cua-permission-read'),
  clearCuaPermission: (id) => ipcRenderer.invoke('pet:cua-permission-clear', id),
  onCuaPermission: (callback) => {
    const listener = (_event, permission) => callback(permission);
    ipcRenderer.on('pet:cua-permission', listener);
    return () => ipcRenderer.removeListener('pet:cua-permission', listener);
  },
  openDshApprovalWindow: (approval) => ipcRenderer.invoke('pet:dsh-approval-open', approval),
  readDshApproval: () => ipcRenderer.invoke('pet:dsh-approval-read'),
  clearDshApproval: (id) => ipcRenderer.invoke('pet:dsh-approval-clear', id),
  onDshApproval: (callback) => {
    const listener = (_event, approval) => callback(approval);
    ipcRenderer.on('pet:dsh-approval', listener);
    return () => ipcRenderer.removeListener('pet:dsh-approval', listener);
  },
});
