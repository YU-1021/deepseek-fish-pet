const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petdBootstrap', {
  read: () => ipcRenderer.invoke('petd:bootstrap'),
  showChat: () => ipcRenderer.invoke('pet:show-chat'),
});
