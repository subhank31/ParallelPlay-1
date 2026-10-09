const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { LinkController } = require('../link/link-controller');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { registerLinkIpc } = require('../link-ipc');

const results = [];
const hang = setTimeout(() => {
  console.error('Electron clock test timed out');
  app.exit(1);
}, 30000);

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

app.whenReady().then(async () => {
  const player = new RecordingPlayer();
  const slave = new SlaveServer({ player, host: '127.0.0.1' });
  const link = new LinkController(new RecordingPlayer(), { sampleIntervalMs: 5, leadMs: 60 });
  registerLinkIpc({ ipcMain, BrowserWindow, link });
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
    const info = await slave.start(0);
    await win.loadFile(path.join(__dirname, 'player-test-page.html'));
    const isolation = await win.webContents.executeJavaScript(`({
      requireType: typeof require,
      hasSync: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.syncClock),
      hasSchedule: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.scheduledPlayTest),
      hasGeneric: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.request)
    })`);
    record(
      'clock ipc isolation',
      isolation.requireType === 'undefined' && isolation.hasSync === 'function' &&
        isolation.hasSchedule === 'function' && isolation.hasGeneric === 'undefined',
      JSON.stringify(isolation)
    );

    const connected = await win.webContents.executeJavaScript(
      `window.electronAPI.link.connect('127.0.0.1', ${info.port})`
    );
    record('clock ipc connect', connected.ok === true, connected.error || connected.snapshot.connection);

    const synced = await win.webContents.executeJavaScript('window.electronAPI.link.syncClock()');
    record(
      'clock ipc sync',
      synced.ok === true && synced.clock.synchronized === true && Number.isFinite(synced.clock.offsetMs),
      synced.ok ? `offset=${synced.clock.offsetMs} rtt=${synced.clock.rttMs} jitter=${synced.clock.jitterMs}` : JSON.stringify(synced.error)
    );
    if (synced.ok) {
      console.log('ELECTRON localhost clock sync (same machine, not a two-Mac result)');
      console.log(`  offset ${synced.clock.offsetMs} ms`);
      console.log(`  rtt ${synced.clock.rttMs} ms`);
      console.log(`  jitter ${synced.clock.jitterMs} ms`);
    }

    await win.webContents.executeJavaScript(`
      window.__exec = null;
      window.electronAPI.link.onEvent((event) => {
        if (event && event.event === 'execution') window.__exec = event;
      });
      true;
    `);
    const scheduled = await win.webContents.executeJavaScript('window.electronAPI.link.scheduledPlayTest()');
    record(
      'clock ipc schedule',
      scheduled.ok === true && scheduled.payload.scheduled === true && scheduled.payload.actualLocalTime === undefined,
      scheduled.ok ? `local=${scheduled.plan.localTargetTime}` : JSON.stringify(scheduled.error)
    );

    const deadline = Date.now() + 1500;
    let execution = null;
    while (Date.now() < deadline) {
      execution = await win.webContents.executeJavaScript('window.__exec');
      if (execution) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    record(
      'clock ipc execution',
      !!execution && Number.isFinite(execution.errorMs) && Math.abs(execution.errorMs) < 250 &&
        player.commands.some((command) => command.type === 'play'),
      execution ? `errorMs=${execution.errorMs}` : 'no execution'
    );
    if (execution) {
      console.log('ELECTRON localhost scheduled execution (same machine, not a two-Mac result)');
      console.log(`  local target ${execution.localTargetTime}`);
      console.log(`  actual ${execution.actualLocalTime}`);
      console.log(`  error ${execution.errorMs} ms`);
    }
  } catch (error) {
    record('electron clock exception', false, error.stack || error.message);
  } finally {
    clearTimeout(hang);
    await link.shutdown();
    await slave.stop();
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} electron clock checks passed`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
