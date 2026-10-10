/**
 * A real Slave app with a Master connected: its controls are locked and it
 * shows the Master's playlist exactly, in order, on the Master's item. When the
 * Master goes away the controls unlock and the playlist stays.
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeWav(filePath, seconds) {
  const data = Buffer.alloc(22050 * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(22050 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function devtools(port) {
  let targets = '';
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await get(`http://127.0.0.1:${port}/json`);
      if (targets.includes('Parallel Playout')) break;
    } catch (error) { /* booting */ }
    await sleep(250);
  }
  const pages = JSON.parse(targets).filter((item) => item.type === 'page');
  const page = pages.find((item) => item.title === 'Parallel Playout') || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')));
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  });
  async function evaluate(expression) {
    const id = nextId++;
    const result = await new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result && result.exceptionDetails) {
      return { error: result.exceptionDetails.exception && result.exceptionDetails.exception.description };
    }
    return result && result.result ? result.result.value : null;
  }
  return { ws, evaluate };
}

const readUi = `(() => {
  const locks = Array.from(document.querySelectorAll('[data-slave-lock]'));
  const rows = Array.from(document.querySelectorAll('.playlist-files li'));
  return {
    role: linkSnapshot && linkSnapshot.role,
    locks: locks.length,
    locked: locks.length > 0 && locks.every((node) => node.inert === true),
    unlocked: locks.length > 0 && locks.every((node) => node.inert === false),
    note: !document.getElementById('slaveLockNote').hidden,
    rows: rows.map((row) => row.textContent),
    missing: rows.map((row) => row.classList.contains('missing')),
    current: rows.findIndex((row) => row.classList.contains('current')),
    name: document.getElementById('masterFileName').textContent,
    index: currentFileIndex
  };
})()`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-slave-role-'));
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  fs.mkdirSync(path.join(masterMedia, 'Set'), { recursive: true });
  fs.mkdirSync(path.join(slaveMedia, 'Set'), { recursive: true });
  // three.wav exists nowhere on this test Mac, as on a Slave that never got the copy.
  for (const name of ['one.wav', 'two.wav']) writeWav(path.join(masterMedia, 'Set', name), 20);
  for (const name of ['one.wav', 'two.wav']) writeWav(path.join(slaveMedia, 'Set', name), 20);
  const playlist = ['one.wav', 'two.wav', 'three.wav'].map((name) => ({
    path: path.join(masterMedia, 'Set', name), name, type: 'audio', duration: 20
  }));

  const slavePort = await freePort();
  const debugPort = await freePort();
  const masterId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const slaveId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const userData = path.join(dir, 'slave-user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    version: 1,
    deviceId: slaveId,
    deviceName: 'Test Slave',
    role: 'slave',
    mediaRoot: slaveMedia,
    listenPort: slavePort,
    paired: { deviceId: masterId, deviceName: 'Test Master', role: 'master', host: '127.0.0.1', port: 47631 }
  }));
  const masterCfgPath = path.join(dir, 'master.json');
  fs.writeFileSync(masterCfgPath, JSON.stringify({
    version: 1,
    deviceId: masterId,
    deviceName: 'Test Master',
    role: 'master',
    mediaRoot: masterMedia,
    listenPort: 47631,
    paired: { deviceId: slaveId, deviceName: 'Test Slave', role: 'slave', host: '127.0.0.1', port: slavePort }
  }));

  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1' }),
    stdio: 'ignore'
  });
  let master = null;
  let ws = null;
  try {
    const tools = await devtools(debugPort);
    ws = tools.ws;
    const { evaluate } = tools;
    let ui = null;
    for (let i = 0; i < 40; i += 1) {
      ui = await evaluate(readUi);
      if (ui && ui.role === 'slave' && linkReady(ui)) break;
      await sleep(250);
    }
    record('slave without a master keeps its controls unlocked', ui && ui.role === 'slave' && ui.unlocked && !ui.note,
      JSON.stringify(ui && { role: ui.role, locks: ui.locks, unlocked: ui.unlocked, note: ui.note }));

    // A Master connects, publishes a three-item playlist, and loads item 1.
    const masterPlayer = new RecordingPlayer();
    master = new LinkController(masterPlayer, { config: new ConfigStore(masterCfgPath), pairRetryDelayMs: 40 });
    await master.setRole('master');
    const started = await master.startPairedSession();
    record('master connects to the paired slave app', started && started.ok === true, started && started.error);
    await masterPlayer.send('load', { path: playlist[0].path });
    master.publishSession({ playlist, currentIndex: 0, playAll: false });
    const mirrored = await master.mirrorLoad(playlist[0].path);
    for (let i = 0; i < 40; i += 1) {
      ui = await evaluate(readUi);
      if (ui && ui.locked && ui.rows.length === 3) break;
      await sleep(150);
    }
    record('slave locks its controls while the master is connected', ui && ui.locked && ui.note,
      JSON.stringify(ui && { locked: ui.locked, note: ui.note }));
    record('slave shows the master playlist in order',
      ui && ui.rows.length === 3 && /one\.wav/.test(ui.rows[0]) && /two\.wav/.test(ui.rows[1]) && /three\.wav/.test(ui.rows[2]),
      JSON.stringify(ui && ui.rows));
    record('a playlist item missing on the slave is shown and marked',
      ui && ui.missing.join() === 'false,false,true' && /not on this Mac/.test(ui.rows[2] || ''),
      JSON.stringify(ui && ui.missing));
    record('slave highlights the master item', mirrored && mirrored.ok && ui && ui.current === 0 && ui.name === 'one.wav',
      JSON.stringify(ui && { current: ui.current, name: ui.name, mirrored: mirrored && (mirrored.ok || mirrored.error) }));

    const refused = await evaluate(`(async () => {
      const load = await window.electronAPI.player.load(${JSON.stringify(path.join(slaveMedia, 'Set', 'two.wav'))});
      const play = await window.electronAPI.player.play();
      const stop = await window.electronAPI.player.stop();
      await playFile();
      const state = await window.electronAPI.player.getState();
      return { load, play, stop, state: state && state.state };
    })()`);
    record('slave refuses local load, play and stop while the master is connected',
      refused && refused.load && refused.load.locked && refused.play && refused.play.locked &&
        refused.stop && refused.stop.locked && refused.state && refused.state.status !== 'playing' &&
        /one\.wav$/.test(refused.state.path || ''),
      JSON.stringify(refused && { load: refused.load, status: refused.state && refused.state.status, path: refused.state && refused.state.path }));

    // The Master moves to item 2.
    await masterPlayer.send('load', { path: playlist[1].path });
    master.publishSession({ playlist, currentIndex: 1, playAll: false });
    await master.mirrorLoad(playlist[1].path);
    for (let i = 0; i < 40; i += 1) {
      ui = await evaluate(readUi);
      if (ui && ui.current === 1) break;
      await sleep(150);
    }
    record('slave follows the master to the next item', ui && ui.current === 1 && ui.name === 'two.wav',
      JSON.stringify(ui && { current: ui.current, name: ui.name }));

    // The Master goes away.
    await master.shutdown();
    master = null;
    for (let i = 0; i < 40; i += 1) {
      ui = await evaluate(readUi);
      if (ui && ui.unlocked) break;
      await sleep(150);
    }
    record('slave unlocks when the master disconnects', ui && ui.unlocked && !ui.note,
      JSON.stringify(ui && { unlocked: ui.unlocked, note: ui.note }));
    record('slave keeps the master playlist after it disconnects', ui && ui.rows.length === 3 && ui.current === 1,
      JSON.stringify(ui && { rows: ui.rows.length, current: ui.current }));
    const local = await evaluate(`(async () => {
      const play = await window.electronAPI.player.play();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = await window.electronAPI.player.getState();
      await window.electronAPI.player.stop();
      return { play, status: state && state.state && state.state.status };
    })()`);
    record('slave operator can play once unlocked', local && local.play && local.play.ok !== false && local.status === 'playing',
      JSON.stringify(local));
  } finally {
    if (master) await master.shutdown().catch(() => {});
    if (ws) ws.close();
    child.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} slave role checks passed`);
  process.exit(failed.length ? 1 : 0);
}

function linkReady(ui) {
  return ui.locks > 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
