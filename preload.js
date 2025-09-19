const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  close: () => ipcRenderer.invoke('close'),
  minimize: () => ipcRenderer.invoke('minimize'),
  connect: () => ipcRenderer.invoke('connect'),
  listPackages: () => ipcRenderer.invoke('list-packages'),
  launchApp: (pkg) => ipcRenderer.invoke('launch-app', pkg)
});
