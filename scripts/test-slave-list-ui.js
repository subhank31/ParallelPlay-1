/**
 * A real Slave app follows the Master's playlist highlight when the Master
 * moves to the next item: when the Master selects before it loads, and when
 * its Load reaches the Slave after the new selection.
 */
process.env.PLAYOUT_MUTE = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PlayerSession } = require('../player-session');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { sleep, writeTone, freePort, devtools } = require('./ui-helpers');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const readUi = `(() => {
  const rows = Array.from(document.querySelectorAll('.playlist-files li'));
  return {
    connected: !!(linkSnapshot && linkSnapshot.masterConnected),
    rows: rows.map((row) => row.textContent),
    current: rows.findIndex((row) => row.classList.contains('current'))
  };
})()`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-slave-list-ui-'));
  const names = ['one.wav', 'two.wav', 'three.wav'];
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  for (const root of [masterMedia, slaveMedia]) {
    fs.mkdirSync(path.join(root, 'Set'), { recursive: true });
    for (const name of names) writeTone(path.join(root, 'Set', name), 30);
  }
  const masterFiles = names.map((name) => path.join(masterMedia, 'Set', name));

  const slavePort = await freePort();
  const debugPort = await freePort();
  const masterId = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const slaveId = 'ffffffff-6666-4666-8666-ffffffffffff';
  const userData = path.join(dir, 'slave-user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    version: 1, deviceId: slaveId, deviceName: 'Test Slave', role: 'slave', mediaRoot: slaveMedia, listenPort: slavePort,
    paired: { deviceId: masterId, deviceName: 'Test Master', role: 'master', host: '127.0.0.1', port: 47631 }
  }));
  const masterCfgPath = path.join(dir, 'master.json');
  fs.writeFileSync(masterCfgPath, JSON.stringify({
    version: 1, deviceId: masterId, deviceName: 'Test Master', role: 'master', mediaRoot: masterMedia, listenPort: 47631,
    paired: { deviceId: slaveId, deviceName: 'Test Slave', role: 'slave', host: '127.0.0.1', port: slavePort }
  }));

  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1' }),
    stdio: 'ignore'
  });
  const masterSession = new PlayerSession();
  masterSession.start();
  const master = new LinkController(masterSession, { config: new ConfigStore(masterCfgPath) });
  let ws = null;
  try {
    const tools = await devtools(debugPort);
    ws = tools.ws;
    const { evaluate } = tools;
    await master.setRole('master');
    let started = null;
    for (let i = 0; i < 40; i += 1) {
      started = await master.startPairedSession();
      if (master.snapshot().connection === 'connected') break;
      await sleep(250);
    }
    record('master connects to the slave app', master.snapshot().connection === 'connected', JSON.stringify(started));

    const playlist = masterFiles.map((file) => ({ path: file, name: path.basename(file), type: 'audio', duration: 30 }));
    const select = (index) => master.publishSession({ playlist, currentIndex: index, playAll: false });
    const waitUi = async (test) => {
      let ui = null;
      for (let i = 0; i < 40; i += 1) {
        ui = await evaluate(readUi);
        if (ui && test(ui)) return ui;
        await sleep(100);
      }
      return ui;
    };
    const slavePlaying = async () => {
      const state = await evaluate('window.electronAPI.player.getState()');
      return state && state.state ? `${path.basename(state.state.path || '')} ${state.state.status}` : 'none';
    };

    // Item 1 on air on both.
    select(0);
    await masterSession.send('load', { path: masterFiles[0] }, 10000);
    await master.mirrorLoad(masterFiles[0]);
    await masterSession.send('play');
    await master.mirrorCommand('play', { state: 'playing' });
    let ui = await waitUi((view) => view.rows.length === 3 && view.current === 0);
    record('slave shows the master playlist on item 1', ui && ui.rows.length === 3 && ui.current === 0,
      JSON.stringify(ui && { rows: ui.rows.length, current: ui.current }));

    // Next as the Master window does it: select item 2, then load and play it.
    select(1);
    ui = await waitUi((view) => view.current === 1);
    record('slave highlights item 2 as soon as the master selects it', ui && ui.current === 1,
      `${JSON.stringify(ui && ui.current)} while playing ${await slavePlaying()}`);
    await masterSession.send('load', { path: masterFiles[1] }, 10000);
    await master.mirrorLoad(masterFiles[1]);
    await masterSession.send('play');
    await master.mirrorCommand('play', { state: 'playing' });
    await sleep(400);
    ui = await evaluate(readUi);
    record('slave keeps item 2 highlighted once it plays it', ui && ui.current === 1 && /two\.wav playing/.test(await slavePlaying()),
      `${ui && ui.current} ${await slavePlaying()}`);

    // The Master's Load overtakes its new selection: the Slave is still on
    // item 2 when the selection of item 3 arrives, and loads item 3 after.
    await masterSession.send('load', { path: masterFiles[2] }, 10000);
    select(2);
    await sleep(300);
    await master.mirrorLoad(masterFiles[2]);
    await masterSession.send('play');
    await master.mirrorCommand('play', { state: 'playing' });
    ui = await waitUi((view) => view.current === 2);
    record('slave highlights item 3 when the load arrives after the selection',
      ui && ui.current === 2 && /three\.wav playing/.test(await slavePlaying()), `${ui && ui.current} ${await slavePlaying()}`);

    // Item 3 ends on the Master and the Master moves the selection to item 2.
    await masterSession.send('stop');
    await master.mirrorCommand('stop');
    select(1);
    ui = await waitUi((view) => view.current === 1);
    record('slave follows a selection without a load', ui && ui.current === 1, `${ui && ui.current} ${await slavePlaying()}`);
  } finally {
    if (ws) ws.close();
    child.kill('SIGTERM');
    await master.shutdown().catch(() => {});
    await masterSession.shutdown().catch(() => {});
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} slave playlist UI checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
