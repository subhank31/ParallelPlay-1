const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { LinkController } = require('../link/link-controller');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { registerLinkIpc } = require('../link-ipc');

const results = [];
const hang = setTimeout(() => {
  console.error('Electron link test timed out');
  app.exit(1);
}, 30000);

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

app.whenReady().then(async () => {
  const player = new RecordingPlayer();
  const slave = new SlaveServer({ player, host: '127.0.0.1' });
  const link = new LinkController(new RecordingPlayer());
  registerLinkIpc({ ipcMain, BrowserWindow, link });
  let info;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    info = await slave.start(0);
    await win.loadFile(path.join(__dirname, 'player-test-page.html'));
    const isolation = await win.webContents.executeJavaScript(`({
      requireType: typeof require,
      hasPing: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.ping),
      hasGeneric: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.request)
    })`);
    record(
      'link ipc isolation',
      isolation.requireType === 'undefined' && isolation.hasPing === 'function' && isolation.hasGeneric === 'undefined',
      JSON.stringify(isolation)
    );

    const connected = await win.webContents.executeJavaScript(
      `window.electronAPI.link.connect('127.0.0.1', ${info.port})`
    );
    record('ipc connect', connected.ok === true && connected.snapshot.connection === 'connected', connected.error || connected.snapshot.connection);

    const ping = await win.webContents.executeJavaScript('window.electronAPI.link.ping()');
    record('ipc ping', ping.ok === true && ping.payload.role === 'slave', ping.error && ping.error.message);

    player.state.status = 'playing';
    player.state.position = 3.5;
    player.state.duration = 12;
    player.state.rate = 1;
    player.state.path = '/tmp/parallel-playout-link-test.mp4';
    const status = await win.webContents.executeJavaScript('window.electronAPI.link.getRemoteStatus()');
    record(
      'ipc getStatus',
      status.ok === true && status.payload.state === 'playing' && status.payload.position === 3.5 && status.payload.file.endsWith('.mp4'),
      status.ok ? `${status.payload.state} ${status.payload.position}` : JSON.stringify(status.error)
    );

    await win.webContents.executeJavaScript('window.electronAPI.link.disconnect()');
    const snapshot = await win.webContents.executeJavaScript('window.electronAPI.link.snapshot()');
    record('ipc disconnect', snapshot.snapshot.connection === 'disconnected', snapshot.snapshot.connection);
  } catch (error) {
    record('electron link exception', false, error.stack || error.message);
  } finally {
    clearTimeout(hang);
    await link.shutdown();
    await slave.stop();
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} electron link checks passed`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
