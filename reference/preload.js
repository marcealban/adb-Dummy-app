const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  close: () => ipcRenderer.invoke('close'),
  minimize: () => ipcRenderer.invoke('minimize'),
  connect: () => ipcRenderer.invoke('connect'),
  setCurrentDevice: (deviceId) => ipcRenderer.invoke('set-current-device', deviceId),
  connectWifi: (ip, port) => ipcRenderer.invoke('connect-wifi', ip, port),
  disconnectDevice: (deviceId) => ipcRenderer.invoke('disconnect-device', deviceId),
  reconnectDevice: (deviceId) => ipcRenderer.invoke('reconnect-device', deviceId),
  refreshDevices: () => ipcRenderer.invoke('refresh-devices'),
  listPackages: (deviceId) => ipcRenderer.invoke('list-packages', deviceId),
  launchApp: (pkg, config) => ipcRenderer.invoke('launch-app', pkg, config),
  getPreferences: (pkg) => ipcRenderer.invoke('get-preferences', pkg),
  resetPreferences: (pkg) => ipcRenderer.invoke('reset-preferences', pkg),
  mirrorScreen: () => ipcRenderer.invoke('mirror-screen'),
  activateAudio: () => ipcRenderer.invoke('activate-audio'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  openShortcuts: () => ipcRenderer.invoke('open-shortcuts'),
  closeShortcuts: () => ipcRenderer.invoke('close-shortcuts'),
  getGlobalSettings: () => ipcRenderer.invoke('get-global-settings'),
  updateGlobalSettings: (settings) => ipcRenderer.invoke('update-global-settings', settings),
  getAudioState: () => ipcRenderer.invoke('get-audio-state'),
  resetAppCounts: () => ipcRenderer.invoke('reset-app-counts'),
  onAppCountsReset: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = () => callback();
    ipcRenderer.on('reset-app-counts', subscription);
    return () => ipcRenderer.removeListener('reset-app-counts', subscription);
  },
  startScrcpyUpdate: () => ipcRenderer.invoke('scrcpy-start-update'),
  onScrcpyLifecycleEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, payload) => callback(payload);
    ipcRenderer.on('scrcpy-lifecycle-event', subscription);
    return () => ipcRenderer.removeListener('scrcpy-lifecycle-event', subscription);
  },
  moveWindow: (deltaX, deltaY) => {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    ipcRenderer.send('move-window', deltaX, deltaY);
  },
  openExternal: (url) => {
    if (typeof url !== 'string') return Promise.resolve(false);
    return ipcRenderer.invoke('open-external', url);
  },
  onPackageLabelStarted: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, pkg) => callback(pkg);
    ipcRenderer.on('package-label-started', subscription);
    return () => ipcRenderer.removeListener('package-label-started', subscription);
  },
  onPackageLabelUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('package-label-updated', subscription);
    return () => ipcRenderer.removeListener('package-label-updated', subscription);
  },
  onAudioStateChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, state) => callback(state);
    ipcRenderer.on('audio-state-changed', subscription);
    return () => ipcRenderer.removeListener('audio-state-changed', subscription);
  }
});
