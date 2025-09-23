const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  close: () => ipcRenderer.invoke('close'),
  minimize: () => ipcRenderer.invoke('minimize'),
  connect: () => ipcRenderer.invoke('connect'),
  listPackages: () => ipcRenderer.invoke('list-packages'),
  launchApp: (pkg) => ipcRenderer.invoke('launch-app', pkg),
  onPackageLabelUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, payload) => callback(payload);
    ipcRenderer.on('package-label-updated', subscription);
    return () => ipcRenderer.removeListener('package-label-updated', subscription);
  },
  onPackageLabelStarted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, pkg) => callback(pkg);
    ipcRenderer.on('package-label-started', subscription);
    return () => ipcRenderer.removeListener('package-label-started', subscription);
  },
  onPackageIconStarted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, pkg) => callback(pkg);
    ipcRenderer.on('package-icon-started', subscription);
    return () => ipcRenderer.removeListener('package-icon-started', subscription);
  },
  onPackageIconUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, payload) => callback(payload);
    ipcRenderer.on('package-icon-updated', subscription);
    return () => ipcRenderer.removeListener('package-icon-updated', subscription);
  }
});
