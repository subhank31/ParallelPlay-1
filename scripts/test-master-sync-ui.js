/**
 * A real Master app restarting while its Slave is on air: it shows what the
 * Slave is playing, locks its controls, and the Sync button joins the Slave
 * and hands control back.
 */
process.env.PLAYOUT_MUTE = '1';
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PlayerSession } = require('../player-session');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeTone(file, seconds) {
  const rate = 22050;
  const data = Buffer.alloc(rate * 2 * seconds);
  for (let i = 0; i < rate * seconds; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
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
  const banner = document.getElementById('masterObserveBanner');
  const rows = Array.from(document.querySelectorAll('.playlist-files li'));
  return {
    role: linkSnapshot && linkSnapshot.role,
    connected: !!(linkSnapshot && linkSnapshot.connection === 'connected'),
    observing: !!(linkSnapshot && linkSnapshot.observing),
    banner: !!banner && !banner.hidden,
    bannerText: document.getElementById('masterObserveText').textContent,
    syncButton: !!document.getElementById('syncWithSlaveBtn') && !document.getElementById('syncWithSlaveBtn').disabled,
    locked: locks.length > 0 && locks.every((node) => node.inert === true),
    unlocked: locks.length > 0 && locks.every((node) => node.inert === false),
    note: document.getElementById('slaveLockNote').hidden ? '' : document.getElementById('slaveLockNote').textContent,
    rows: rows.map((row) => row.textContent),
    current: rows.findIndex((row) => row.classList.contains('current')),
    response: document.getElementById('responseBox').textContent
  };
})()`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-master-sync-ui-'));
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  for (const root of [masterMedia, slaveMedia]) {
    fs.mkdirSync(path.join(root, 'Set'), { recursive: true });
    for (const name of ['one.wav', 'two.wav', 'three.wav']) writeTone(path.join(root, 'Set', name), 60);
  }
  const slaveFiles = ['one.wav', 'two.wav', 'three.wav'].map((name) => path.join(slaveMedia, 'Set', name));

  const slavePort = await freePort();
  const debugPort = await freePort();
  const masterId = 'cccccccc-3333-4333-8333-cccccccccccc';
  const slaveId = 'dddddddd-4444-4444-8444-dddddddddddd';
  const slaveCfgPath = path.join(dir, 'slave.json');
  fs.writeFileSync(slaveCfgPath, JSON.stringify({
    version: 1, deviceId: slaveId, deviceName: 'Test Slave', role: 'slave', mediaRoot: slaveMedia, listenPort: slavePort,
    paired: { deviceId: masterId, deviceName: 'Test Master', role: 'master', host: '127.0.0.1', port: 47631 }
  }));
  const userData = path.join(dir, 'master-user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    version: 1, deviceId: masterId, deviceName: 'Test Master', role: 'master', mediaRoot: masterMedia, listenPort: 47631,
    paired: { deviceId: slaveId, deviceName: 'Test Slave', role: 'slave', host: '127.0.0.1', port: slavePort }
  }));

  // The Slave is on air with item 2 of a 3-item playlist the Master gave it earlier.
  const slaveSession = new PlayerSession();
  slaveSession.start();
  const slave = new LinkController(slaveSession, { config: new ConfigStore(slaveCfgPath) });
  await slave.setRole('slave');
  await slave.listen(slavePort);
  slave.publishSession({
    playlist: slaveFiles.map((file) => ({ path: file, name: path.basename(file), type: 'audio', duration: 60 })),
    currentIndex: 1,
    playAll: false
  });
  await slaveSession.send('load', { path: slaveFiles[1] }, 10000);
  await slaveSession.send('seek', { seconds: 7 }, 10000);
  await slaveSession.send('play');
  const slaveCommandsBefore = [];
  const realSend = slaveSession.send.bind(slaveSession);
  slaveSession.send = (type, fields, timeout) => {
    if (type !== 'getState') slaveCommandsBefore.push(type);
    return realSend(type, fields, timeout);
  };

  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1' }),
    stdio: 'ignore'
  });
  let ws = null;
  try {
    const tools = await devtools(debugPort);
    ws = tools.ws;
    const { evaluate } = tools;
    let ui = null;
    for (let i = 0; i < 60; i += 1) {
      ui = await evaluate(readUi);
      if (ui && ui.banner && ui.observing) break;
      await sleep(250);
    }
    record('restarted master shows the slave on air', ui && ui.banner && /two\.wav/.test(ui.bannerText) && /item 2 of 3/.test(ui.bannerText) &&
      /Playing/.test(ui.bannerText), ui && ui.bannerText);
    record('restarted master locks its controls and offers Sync', ui && ui.locked && /Sync/.test(ui.note) && ui.syncButton,
      JSON.stringify(ui && { locked: ui.locked, note: ui.note, sync: ui.syncButton }));
    const refused = await evaluate(`(async () => {
      const play = await window.electronAPI.player.play();
      await stopFile();
      return play;
    })()`);
    record('a watching master refuses local transport', refused && refused.locked === true, JSON.stringify(refused));
    record('the slave received no transport while the master watched', slaveCommandsBefore.length === 0, slaveCommandsBefore.join(','));

    await evaluate('syncWithSlave()');
    for (let i = 0; i < 40; i += 1) {
      ui = await evaluate(readUi);
      if (ui && !ui.banner && ui.unlocked && ui.rows.length === 3) break;
      await sleep(200);
    }
    record('after Sync the banner closes and controls unlock', ui && !ui.banner && ui.unlocked && !ui.observing,
      JSON.stringify(ui && { banner: ui.banner, unlocked: ui.unlocked, observing: ui.observing }));
    record('after Sync the master shows the slave playlist on the slave item',
      ui && ui.rows.length === 3 && /one\.wav/.test(ui.rows[0]) && ui.current === 1,
      JSON.stringify(ui && { rows: ui.rows, current: ui.current }));
    record('after Sync the master reports how close it is', ui && /In sync with the Slave \(within \d+ ms\)/.test(ui.response),
      ui && (ui.response.match(/In sync[^.]*\./) || ['no message'])[0]);
    const master = await evaluate('window.electronAPI.player.getState()');
    const slaveState = (await realSend('getState', {}, 5000)).state;
    const driftMs = master && master.state ? ((master.state.position + (slaveState.hostTime - master.state.hostTime)) - slaveState.position) * 1000 : null;
    record('master plays the slave item in step', master && master.state && master.state.status === 'playing' &&
      /two\.wav$/.test(master.state.path) && driftMs != null && Math.abs(driftMs) <= 25,
      `${master && master.state && master.state.status} drift ${driftMs == null ? 'n/a' : driftMs.toFixed(1)} ms`);
    record('Sync never sent a transport command to the slave', slaveCommandsBefore.length === 0, slaveCommandsBefore.join(','));

    await evaluate('stopFile()');
    await sleep(500);
    const stopped = (await realSend('getState', {}, 5000)).state;
    record('Stop on the synced master stops the slave', stopped.status === 'stopped', stopped.status);
  } finally {
    if (ws) ws.close();
    child.kill('SIGTERM');
    await slave.shutdown().catch(() => {});
    await slaveSession.shutdown().catch(() => {});
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} master sync UI checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
