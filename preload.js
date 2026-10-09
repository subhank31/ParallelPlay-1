const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openSingleFile: () => ipcRenderer.invoke('dialog:openSingleFile'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  player: {
    load: (filePath) => ipcRenderer.invoke('player:load', filePath),
    play: () => ipcRenderer.invoke('player:play'),
    pause: () => ipcRenderer.invoke('player:pause'),
    stop: () => ipcRenderer.invoke('player:stop'),
    seek: (seconds) => ipcRenderer.invoke('player:seek', seconds),
    setRate: (rate) => ipcRenderer.invoke('player:setRate', rate),
    getState: () => ipcRenderer.invoke('player:getState'),
    recover: () => ipcRenderer.invoke('player:recover'),
    inspect: (filePath) => ipcRenderer.invoke('player:inspect', filePath),
    fullscreen: (enabled) => ipcRenderer.invoke('player:fullscreen', enabled),
    setDisplay: (displayIndex) => ipcRenderer.invoke('player:setDisplay', displayIndex),
    scheduledPlay: (options) => ipcRenderer.invoke('player:scheduledPlay', options),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('player:event', listener);
      return () => ipcRenderer.removeListener('player:event', listener);
    }
  },
  link: {
    snapshot: () => ipcRenderer.invoke('link:snapshot'),
    setRole: (role) => ipcRenderer.invoke('link:setRole', role),
    listen: (port) => ipcRenderer.invoke('link:listen', port),
    connect: (host, port) => ipcRenderer.invoke('link:connect', host, port),
    requestPairing: (host, port) => ipcRenderer.invoke('link:requestPairing', host, port),
    acceptPairing: (requestId) => ipcRenderer.invoke('link:acceptPairing', requestId),
    rejectPairing: (requestId) => ipcRenderer.invoke('link:rejectPairing', requestId),
    unpair: () => ipcRenderer.invoke('link:unpair'),
    disconnect: () => ipcRenderer.invoke('link:disconnect'),
    ping: () => ipcRenderer.invoke('link:ping'),
    getRemoteStatus: () => ipcRenderer.invoke('link:getRemoteStatus'),
    syncClock: () => ipcRenderer.invoke('link:syncClock'),
    scheduledPlayTest: () => ipcRenderer.invoke('link:scheduledPlayTest'),
    setMediaRoot: (root) => ipcRenderer.invoke('link:setMediaRoot', root),
    setDeviceName: (name) => ipcRenderer.invoke('link:setDeviceName', name),
    mirrorLoad: (absolutePath) => ipcRenderer.invoke('link:mirrorLoad', absolutePath),
    mirrorCommand: (type, payload) => ipcRenderer.invoke('link:mirrorCommand', type, payload),
    openSlaveApp: () => ipcRenderer.invoke('link:openSlaveApp'),
    startPairedSession: () => ipcRenderer.invoke('link:startPairedSession'),
    publishSession: (session) => ipcRenderer.invoke('link:publishSession', session),
    recover: () => ipcRenderer.invoke('link:recover'),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('link:event', listener);
      return () => ipcRenderer.removeListener('link:event', listener);
    }
  }
});
