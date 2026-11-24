'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearth', {
  request: (method, path, body) => ipcRenderer.invoke('hearth:request', { method, path, body }),
  status: () => ipcRenderer.invoke('hearth:server-status'),
  control: action => ipcRenderer.invoke('hearth:control', action),
  setRestart: enabled => ipcRenderer.invoke('hearth:set-restart', enabled),
  setLoginItem: enabled => ipcRenderer.invoke('hearth:set-login-item', enabled),
  getLoginItem: () => ipcRenderer.invoke('hearth:get-login-item'),
  pickDirectory: () => ipcRenderer.invoke('hearth:pick-directory'),
  pickFile: filters => ipcRenderer.invoke('hearth:pick-file', filters),
  saveFile: defaultName => ipcRenderer.invoke('hearth:save-file', defaultName),
  download: (path, defaultName) => ipcRenderer.invoke('hearth:download', { path, defaultName }),
  restoreBackup: filePath => ipcRenderer.invoke('hearth:upload-restore', filePath),
  openExternal: url => ipcRenderer.invoke('hearth:open-external', url),
  showItem: path => ipcRenderer.invoke('hearth:show-item', path),
  serviceInstall: () => ipcRenderer.invoke('hearth:service-install'),
  serviceControl: action => ipcRenderer.invoke('hearth:service-control', action),
  serviceStatus: () => ipcRenderer.invoke('hearth:service-status'),
  updateCheck: url => ipcRenderer.invoke('hearth:update-check', url),
  updateDownload: payload => ipcRenderer.invoke('hearth:update-download', payload),
  updateRun: path => ipcRenderer.invoke('hearth:update-run', path),
  onServerStatus: listener => {
    const wrapped = (event, value) => listener(value);
    ipcRenderer.on('hearth:server-status', wrapped);
    return () => ipcRenderer.removeListener('hearth:server-status', wrapped);
  }
});
