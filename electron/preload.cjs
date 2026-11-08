const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('soulLiberator', {
  inspectClientData: () => ipcRenderer.invoke('client-data:inspect'),
  loadPlanner: () => ipcRenderer.invoke('planner:load'),
  saveWorkspace: state => ipcRenderer.invoke('planner:save', state),
  setPrice: (id, price) => ipcRenderer.invoke('planner:price', id, price),
  saveSource: (input, replaceKey) => ipcRenderer.invoke('planner:source-save', input, replaceKey),
  removeSource: key => ipcRenderer.invoke('planner:source-remove', key),
  restoreSource: key => ipcRenderer.invoke('planner:source-restore', key),
  history: direction => ipcRenderer.invoke('planner:history', direction),
  setHotkeys: (undoKey, redoKey) => ipcRenderer.invoke('planner:hotkeys', undoKey, redoKey),
  windowControl: command => ipcRenderer.invoke('window:control', command),
  resizeWindow: (command, edge, amount) => ipcRenderer.invoke('window:resize', command, edge, amount),
})
