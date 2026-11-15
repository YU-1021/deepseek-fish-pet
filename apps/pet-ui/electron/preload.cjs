const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petdBootstrap', {
  read: () => ipcRenderer.invoke('petd:bootstrap'),
  toggleIgnoreMouse: (ignore) => ipcRenderer.invoke('pet:toggle-ignore-mouse', ignore),
  showChat: () => ipcRenderer.invoke('pet:show-chat'),
});
