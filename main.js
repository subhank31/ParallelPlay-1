const { app, BrowserWindow, dialog, ipcMain, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { PlayerSession } = require('./player-session');
const { registerPlayerIpc, expandPlaylistSelection } = require('./player-ipc');
const { LinkController } = require('./link/link-controller');
const { registerLinkIpc } = require('./link-ipc');
const { ConfigStore, DEFAULT_PORT } = require('./link/config-store');
const { activateApp, appBundlePath } = require('./link/open-app');
const { checkFirewall } = require('./link/firewall');
const { installFileLog } = require('./link/file-log');
const { mediaDialogFilters, playlistDialogOptions } = require('./dialog-filters');

const session = new PlayerSession();
let config = null;
let link = null;
let quitting = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
  });
}

function registerDialogs() {
  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(playlistDialogOptions());
    if (canceled) return null;
    return expandPlaylistSelection(filePaths);
  });

  ipcMain.handle('dialog:openSingleFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: mediaDialogFilters(),
      title: 'Select a Media File'
    });
    if (canceled) return null;
    return filePaths;
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Media Directory'
    });
    if (canceled) return null;
    return filePaths && filePaths[0] ? filePaths[0] : null;
  });
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function migrateLegacyRole(store) {
  const legacy = path.join(app.getPath('userData'), 'role.json');
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  } catch (error) {
    return;
  }
  try {
    fs.renameSync(legacy, `${legacy}.migrated`);
  } catch (error) {
    console.error(`[config] could not retire ${legacy}: ${error.message}`);
    return;
  }
  if (saved && (saved.role === 'master' || saved.role === 'slave')) {
    if (!store.data.paired) store.setRole(saved.role);
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`[app] received ${signal}`);
  });
}
process.on('uncaughtException', (error) => {
  console.error(`[app] kept running after an error: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (error) => {
  const text = error && error.stack ? error.stack : error;
  console.error(`[app] unhandled rejection: ${text}`);
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.error('[app] second instance launch — focusing existing window (not a crash restart)');
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const win = windows[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(async () => {
  if (!singleInstance) return;
  const logFile = installFileLog(path.join(app.getPath('userData'), 'logs', 'parallel-playout.log'));
  console.error(`[app] started ${app.getVersion()} pid ${process.pid} from ${process.execPath}${logFile ? ` (log ${logFile})` : ''}`);
  config = new ConfigStore(configPath());
  migrateLegacyRole(config);

  if (process.env.PLAYOUT_ROLE === 'master' || process.env.PLAYOUT_ROLE === 'slave') {
    config.setRole(process.env.PLAYOUT_ROLE);
  }
  if (process.env.PLAYOUT_PORT) {
    const port = Number(process.env.PLAYOUT_PORT);
    if (Number.isInteger(port)) config.setListenPort(port);
  }

  link = new LinkController(session, {
    config,
    openApp: () => activateApp({ app, BrowserWindow, createWindow }),
    checkFirewall: () => checkFirewall(appBundlePath() || process.execPath)
  });

  registerDialogs();
  registerPlayerIpc({
    ipcMain,
    BrowserWindow,
    session,
    isLocked: () => {
      if (link.role === 'slave') return link.masterConnected === true && !!link.authorizedOnSlave();
      return link.observing || link.syncing ? 'The Slave is on air. Press Sync to join it and take control.' : false;
    }
  });
  registerLinkIpc({
    ipcMain,
    BrowserWindow,
    link,
    onRole: async (role) => {
      if (role !== 'slave') return null;
      return link.listen(config.data.listenPort || DEFAULT_PORT);
    }
  });
  session.on('log', (line) => {
    console.error(`[PlayoutEngine] ${line}`);
  });
  session.start();

  await link.setRole(config.data.role || 'master');
  const started = await link.startPairedSession();
  if (started && started.ok === false && started.reconnecting) {
    console.error(`[link] paired peer offline — reconnecting: ${started.error}`);
  } else if (started && started.ok === false) {
    console.error(`[link] ${started.error}`);
  } else if (link.role === 'slave' && link.listening) {
    console.error(`[link] slave listening on ${link.listenPort}`);
  } else if (link.role === 'master' && config.getPaired()) {
    console.error(`[link] master paired with ${config.getPaired().host}`);
  }

  createWindow();

  powerMonitor.on('suspend', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('player:event', { event: 'sleep' });
    }
  });
  powerMonitor.on('resume', () => {
    if (!link) return;
    link.recoverAfterWake().catch((error) => {
      console.error(`[player] wake recovery failed: ${error.message}`);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  console.error('[app] quit requested');
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.all([
    link ? link.shutdown() : Promise.resolve(),
    session.shutdown()
  ]).finally(() => app.quit());
});
