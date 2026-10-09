function registerLinkIpc({ ipcMain, BrowserWindow, link, onRole }) {
  function broadcast(payload) {
    let safe = payload;
    try {
      safe = JSON.parse(JSON.stringify(payload));
    } catch (error) {
      console.error('[link] dropped an event that could not be shown');
      return;
    }
    const windows = BrowserWindow.getAllWindows();
    if (safe && safe.event === 'pair-request') {
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        if (win.isMinimized()) win.restore();
        win.show();
      }
    }
    for (const win of windows) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send('link:event', safe);
      } catch (error) {
        console.error(`[link] could not update the window: ${error.message}`);
      }
    }
  }

  link.on('event', broadcast);

  ipcMain.handle('link:snapshot', () => ({ ok: true, snapshot: link.snapshot() }));
  ipcMain.handle('link:setRole', async (_event, role) => {
    const result = await link.setRole(role);
    if (!result.ok || typeof onRole !== 'function') return result;
    const followed = await onRole(role);
    return followed || result;
  });
  ipcMain.handle('link:listen', (_event, port) => link.listen(port));
  ipcMain.handle('link:connect', (_event, host, port) => link.connect(host, port));
  ipcMain.handle('link:requestPairing', (_event, host, port) => link.requestPairing(host, port));
  ipcMain.handle('link:acceptPairing', (_event, requestId) => link.acceptPairing(requestId));
  ipcMain.handle('link:rejectPairing', (_event, requestId) => link.rejectPairing(requestId));
  ipcMain.handle('link:unpair', () => link.unpair());
  ipcMain.handle('link:disconnect', () => link.disconnect());
  ipcMain.handle('link:ping', () => link.ping());
  ipcMain.handle('link:getRemoteStatus', () => link.getRemoteStatus());
  ipcMain.handle('link:syncClock', () => link.syncClock());
  ipcMain.handle('link:scheduledPlayTest', () => link.scheduledPlayTest());
  ipcMain.handle('link:setMediaRoot', (_event, root) => link.setMediaRoot(root));
  ipcMain.handle('link:setDeviceName', (_event, name) => link.setDeviceName(name));
  ipcMain.handle('link:mirrorLoad', (_event, absolutePath) => link.mirrorLoad(absolutePath));
  ipcMain.handle('link:mirrorCommand', (_event, type, payload) => link.mirrorCommand(type, payload || {}));
  ipcMain.handle('link:openSlaveApp', () => link.openSlaveApp());
  ipcMain.handle('link:startPairedSession', () => link.startPairedSession());
  ipcMain.handle('link:publishSession', (_event, session) => link.publishSession(session));
  ipcMain.handle('link:recover', () => link.recoverAfterWake());
}

module.exports = { registerLinkIpc };
