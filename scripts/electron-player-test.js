const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { PlayerSession } = require('../player-session');
const { registerPlayerIpc } = require('../player-ipc');

process.env.PLAYOUT_MUTE = '1';
const video = process.env.PLAYOUT_TEST_VIDEO || '/Users/subhank/Desktop/Finals/Sub 1.mp4';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const hang = setTimeout(() => {
  console.error('Electron player test timed out');
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  const session = new PlayerSession();
  registerPlayerIpc({ ipcMain, BrowserWindow, session });
  session.on('log', (line) => console.error(`[PlayoutEngine] ${line}`));
  session.start();

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
    await win.loadFile(path.join(__dirname, 'player-test-page.html'));
    const isolation = await win.webContents.executeJavaScript(`({
      requireType: typeof require,
      processType: typeof process,
      hasLoad: typeof (window.electronAPI && window.electronAPI.player && window.electronAPI.player.load),
      hasFs: typeof window.fs,
      hasChildProcess: typeof window.child_process
    })`);
    record(
      'renderer isolation',
      isolation.requireType === 'undefined' &&
        isolation.hasLoad === 'function' &&
        isolation.hasFs === 'undefined' &&
        isolation.hasChildProcess === 'undefined',
      JSON.stringify(isolation)
    );

    const mkvPath = '/tmp/parallel-playout-unsupported.mkv';
    fs.writeFileSync(mkvPath, '');
    const mkv = await win.webContents.executeJavaScript(
      `window.electronAPI.player.load(${JSON.stringify(mkvPath)})`
    );
    record('ipc rejects mkv', mkv.ok === false && /not supported/.test(mkv.error || ''), mkv.error || '');

    if (!fs.existsSync(video)) throw new Error(`Missing test video ${video}`);
    const loaded = await win.webContents.executeJavaScript(
      `window.electronAPI.player.load(${JSON.stringify(video)})`
    );
    record(
      'ipc load mp4',
      loaded.ok === true && loaded.state && loaded.state.duration > 1,
      `duration=${loaded.state && loaded.state.duration} error=${loaded.error || ''}`
    );
    if (!loaded.ok) throw new Error(loaded.error || 'ipc load failed');

    const target = Math.min(8, loaded.state.duration * 0.4);
    const sought = await win.webContents.executeJavaScript(
      `window.electronAPI.player.seek(${target})`
    );
    record(
      'ipc seek',
      sought.ok === true && Math.abs(sought.state.position - target) < 0.75,
      `position=${sought.state && sought.state.position}`
    );

    await win.webContents.executeJavaScript('window.electronAPI.player.play()');
    await sleep(350);
    const playing = await win.webContents.executeJavaScript('window.electronAPI.player.getState()');
    record('ipc play state', playing.ok === true && playing.state.status === 'playing', `status=${playing.state && playing.state.status}`);

    const paused = await win.webContents.executeJavaScript('window.electronAPI.player.pause()');
    record(
      'ipc pause keeps position',
      paused.ok === true && paused.state.status === 'paused' && paused.state.position > 1,
      `position=${paused.state && paused.state.position}`
    );
    const resumedPause = await win.webContents.executeJavaScript('window.electronAPI.player.play()');
    await sleep(350);
    const afterPause = await win.webContents.executeJavaScript('window.electronAPI.player.getState()');
    record(
      'ipc play resumes from pause',
      resumedPause.ok === true && afterPause.state.position > paused.state.position - 0.25,
      `paused=${paused.state.position} now=${afterPause.state.position}`
    );
    await win.webContents.executeJavaScript('window.electronAPI.player.pause()');
    const stopped = await win.webContents.executeJavaScript('window.electronAPI.player.stop()');
    record(
      'ipc stop returns to the start',
      stopped.ok === true &&
        stopped.state.status === 'stopped' &&
        stopped.state.position < 0.05,
      `position=${stopped.state && stopped.state.position}`
    );

    const resumed = await win.webContents.executeJavaScript('window.electronAPI.player.play()');
    await sleep(400);
    const afterResume = await win.webContents.executeJavaScript('window.electronAPI.player.getState()');
    record(
      'ipc play after stop starts at the beginning',
      resumed.ok === true && afterResume.state.position < 1.5,
      `now=${afterResume.state.position}`
    );

    for (const rate of [0.5, 1, 1.5]) {
      const rated = await win.webContents.executeJavaScript(`window.electronAPI.player.setRate(${rate})`);
      record(`ipc setRate ${rate}`, rated.ok === true && Math.abs(rated.state.rate - rate) < 0.01, `rate=${rated.state && rated.state.rate}`);
    }

    const display = await win.webContents.executeJavaScript('window.electronAPI.player.setDisplay(0)');
    record('ipc setDisplay', display.ok === true && display.state.displayIndex === 0, display.error || '');

    await win.webContents.executeJavaScript('window.electronAPI.player.fullscreen(true)');
    let fullscreen = false;
    for (let i = 0; i < 15 && !fullscreen; i += 1) {
      await sleep(200);
      const state = await win.webContents.executeJavaScript('window.electronAPI.player.getState()');
      fullscreen = !!(state.state && state.state.fullscreen);
    }
    record('ipc fullscreen', fullscreen, `fullscreen=${fullscreen}`);
    await win.webContents.executeJavaScript('window.electronAPI.player.fullscreen(false)');

    await win.webContents.executeJavaScript(`
      window.__events = [];
      window.electronAPI.player.onEvent((event) => window.__events.push(event));
      true;
    `);
    const pid = session.child && session.child.pid;
    if (!pid) throw new Error('Helper pid missing before crash test');
    process.kill(pid, 'SIGKILL');
    let sawCrash = false;
    let sawReady = false;
    for (let i = 0; i < 30 && !(sawCrash && sawReady); i += 1) {
      await sleep(200);
      const names = await win.webContents.executeJavaScript(
        'window.__events.map((event) => event.event)'
      );
      sawCrash = names.includes('helper-crashed');
      sawReady = names.includes('helper-ready');
    }
    record('ipc sees helper crash', sawCrash, `events include crash=${sawCrash}`);
    record('helper restarted', sawReady, `events include ready=${sawReady}`);

    const afterCrash = await win.webContents.executeJavaScript('window.electronAPI.player.getState()');
    record(
      'state after restart',
      afterCrash.ok === true && afterCrash.state && afterCrash.state.status === 'idle',
      `status=${afterCrash.state && afterCrash.state.status} error=${afterCrash.error || ''}`
    );
  } catch (error) {
    record('electron test exception', false, error.stack || error.message);
  } finally {
    clearTimeout(hang);
    await session.shutdown();
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} electron checks passed`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
