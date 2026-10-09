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
const crashes = [];
process.on('uncaughtException', (error) => crashes.push(error.stack || String(error)));
process.on('unhandledRejection', (error) => crashes.push(error && error.stack ? error.stack : String(error)));

function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label, predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error(`timeout: ${label}`);
}

function oncePair(slave) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pair request did not arrive')), 8000);
    const onEvent = (event) => {
      if (!event || event.event !== 'pair-request') return;
      clearTimeout(timer);
      slave.off('event', onEvent);
      resolve(event);
    };
    slave.on('event', onEvent);
  });
}

async function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function controllers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-flow-'));
  const port = 0;
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  slaveCfg.setRole('slave');
  masterCfg.setRole('master');
  const slaveId = slaveCfg.data.deviceId;
  const masterId = masterCfg.data.deviceId;
  const slave = new LinkController(new RecordingPlayer(), { config: slaveCfg, pairRetryDelayMs: 40 });
  const master = new LinkController(new RecordingPlayer(), { config: masterCfg, pairRetryDelayMs: 40 });
  await slave.setRole('slave');
  await master.setRole('master');
  return { dir, port, slave, master, slaveCfg, masterCfg, slaveId, masterId };
}

async function unit() {
  const open = await controllers();
  const asked = oncePair(open.slave);
  const listening = await open.slave.listen(0);
  const port = listening.snapshot.port;
  const again = await open.slave.listen(port);
  record(
    'repeated listen keeps a single listener',
    again.ok === true && open.slave.listening === true && (await portFree(port)) === false,
    `listening=${open.slave.listening}`
  );
  const pairing = open.master.requestPairing('127.0.0.1', port);
  const request = await asked;
  open.slave.acceptPairing(request.requestId);
  const paired = await pairing;
  const ping = await open.master.ping();
  record(
    'request, accept, paired, and ping',
    paired.ok === true &&
      open.master.snapshot().connection === 'connected' &&
      open.slave.snapshot().paired === true &&
      open.slave.snapshot().connection === 'connected' &&
      ping.ok === true,
    paired.error || (ping.error && ping.error.message)
  );

  let extraRequests = 0;
  open.slave.on('event', (event) => {
    if (event && event.event === 'pair-request') extraRequests += 1;
  });
  open.master.client.socket.destroy();
  await waitUntil('master reconnects', async () => {
    if (open.master.snapshot().connection !== 'connected' || open.slave.snapshot().authorized !== true) return false;
    const ping = await open.master.ping();
    return ping.ok === true;
  });
  record(
    'disconnect reconnects without a new approval',
    open.master.snapshot().paired === true && extraRequests === 0 && open.slaveId === open.slaveCfg.data.deviceId,
    `extraRequests=${extraRequests}`
  );

  await open.master.unpair();
  await waitUntil('slave pairing cleared', () => !open.slaveCfg.getPaired());
  const rejectedRequest = oncePair(open.slave);
  const rejectedPairing = open.master.requestPairing('127.0.0.1', port);
  const rejected = await rejectedRequest;
  open.slave.rejectPairing(rejected.requestId);
  const rejection = await rejectedPairing;
  await sleep(80);
  record(
    'reject leaves both sides stable and unpaired',
    rejection.ok === false &&
      open.master.snapshot().paired === false &&
      open.slave.snapshot().paired === false &&
      open.slave.listening === true &&
      open.slaveCfg.data.deviceId === open.slaveId &&
      open.masterCfg.data.deviceId === open.masterId,
    rejection.error
  );

  const second = oncePair(open.slave);
  const secondPairing = open.master.requestPairing('127.0.0.1', port);
  const secondRequest = await second;
  open.slave.acceptPairing(secondRequest.requestId);
  const secondPaired = await secondPairing;
  record('a later request can be accepted', secondPaired.ok === true, secondPaired.error);

  await open.slave.shutdown();
  await open.master.shutdown();

  const late = await controllers();
  const lateSlaveAsked = oncePair(late.slave);
  const latePort = 47679;
  const latePairing = late.master.requestPairing('127.0.0.1', latePort);
  await waitUntil('slave unavailable', () => {
    const snap = late.master.snapshot();
    return snap.slaveUnavailable === true && snap.paired === false && snap.pairingState === 'requesting';
  });
  record(
    'master keeps its identity while the slave is offline',
    late.masterCfg.data.deviceId === late.masterId &&
      late.master.snapshot().pairingState === 'requesting' &&
      late.master.snapshot().slaveUnavailable === true &&
      late.master.snapshot().paired === false,
    late.master.snapshot().lastPairError
  );
  const lateListen = await late.slave.listen(latePort);
  const lateRequest = await lateSlaveAsked;
  late.slave.acceptPairing(lateRequest.requestId);
  const latePaired = await latePairing;
  record(
    'master open first connects when the slave starts',
    lateListen.ok === true && latePaired.ok === true && late.master.snapshot().connection === 'connected',
    latePaired.error || lateListen.error
  );
  const slaveIdAfter = late.slaveCfg.data.deviceId;
  await late.slave.shutdown();
  await sleep(100);
  const revived = new LinkController(new RecordingPlayer(), { config: late.slaveCfg, pairRetryDelayMs: 40 });
  await revived.setRole('slave');
  await revived.listen(latePort);
  await waitUntil(
    'slave open later reconnects',
    () => late.master.snapshot().connection === 'connected' && revived.snapshot().authorized === true
  );
  record(
    'slave open later reconnects without resetting identity',
    revived.snapshot().connection === 'connected' && late.slaveCfg.data.deviceId === slaveIdAfter,
    late.slaveCfg.data.deviceId
  );
  await revived.shutdown();
  await late.master.shutdown();
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function launch(role, port, userData, debugPort, fresh = true) {
  if (fresh) {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.mkdirSync(userData, { recursive: true });
  }
  const packaged = process.env.PLAYOUT_APP;
  const electron = packaged || path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const args = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`];
  const child = spawn(electron, packaged ? args : ['.'].concat(args), {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PLAYOUT_ROLE: role,
      PLAYOUT_PORT: String(port),
      PLAYOUT_MUTE: '1'
    }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  child.log = () => log;
  return child;
}

function stopApp(child) {
  if (!child || child.exitCode != null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    try { child.kill('SIGKILL'); } catch (killError) { /* already gone */ }
  }
}

async function attach(debugPort) {
  let targets = '';
  for (let i = 0; i < 50; i += 1) {
    try {
      targets = await get(`http://127.0.0.1:${debugPort}/json`);
      if (targets.includes('Parallel Playout')) break;
    } catch (error) { /* booting */ }
    await sleep(200);
  }
  const pages = JSON.parse(targets).filter((item) => item.type === 'page');
  const page = pages.find((item) => item.title === 'Parallel Playout') || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')));
  });
  let next = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  function send(method, params) {
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function evaluate(expression) {
    const evaluated = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    const details = evaluated.result && evaluated.result.exceptionDetails;
    if (details) {
      const text = details.exception && details.exception.description ? details.exception.description : details.text;
      throw new Error(text || 'renderer exception');
    }
    const remote = evaluated.result && evaluated.result.result;
    return remote ? remote.value : null;
  }
  return { evaluate, close: () => ws.close() };
}

async function uiText(session) {
  return session.evaluate(`JSON.stringify({
    role: document.getElementById('topRole').textContent,
    conn: document.getElementById('topConnection').textContent,
    line: document.getElementById('linkStatusLine').textContent,
    onPlayer: !!(document.getElementById('page-player') && !document.getElementById('page-player').hidden),
    popup: (function () {
      const popup = document.getElementById('connectionRequestPopup');
      const title = document.getElementById('connectionRequestTitle');
      const body = document.getElementById('connectionRequestBody');
      if (!popup || popup.hidden || popup.getClientRects().length === 0) return '';
      return (title ? title.textContent : '') + '|' + (body ? body.textContent : '');
    })(),
    status: document.getElementById('pairRequestStatus') ? document.getElementById('pairRequestStatus').textContent : ''
  })`);
}

function popupShown(text) {
  return text.onPlayer === true &&
    text.popup.indexOf('Connection Request|Parallel Playout Master at ') === 0 &&
    text.popup.indexOf(' wants to connect.') > 0;
}

async function apps() {
  const port = 47681;
  const slaveData = '/tmp/pp-flow-slave-app';
  const masterData = '/tmp/pp-flow-master-app';
  const slave = launch('slave', port, slaveData, 9255);
  const master = launch('master', port, masterData, 9256);
  let slaveUi;
  let masterUi;
  let masterAgain = null;
  let masterUiAgain = null;
  try {
    slaveUi = await attach(9255);
    masterUi = await attach(9256);
    await waitUntil('slave listening', async () => {
      const text = JSON.parse(await uiText(slaveUi));
      return text.conn === 'Listening';
    }, 12000);
    const slaveBefore = await slaveUi.evaluate(`(async () => (await window.electronAPI.link.snapshot()).snapshot.identity.deviceId)()`);
    masterUi.evaluate(`(() => {
      document.getElementById('slaveHost').value = '127.0.0.1';
      document.getElementById('slavePort').value = '${port}';
      requestSlavePairing();
      return true;
    })()`);
    await waitUntil('incoming request', async () => popupShown(JSON.parse(await uiText(slaveUi))), 10000);
    await slaveUi.evaluate(`document.querySelector('#connectionRequestPopup .btn.primary').click()`);
    await waitUntil('both paired', async () => {
      const left = JSON.parse(await uiText(slaveUi));
      const right = JSON.parse(await uiText(masterUi));
      return left.conn === 'Paired' && right.conn === 'Paired';
    }, 10000);
    const ping = await masterUi.evaluate(`(async () => {
      const result = await window.electronAPI.link.ping();
      return !!(result && result.ok);
    })()`);
    record('both apps request, accept, and ping', ping === true && slave.exitCode == null && master.exitCode == null);

    master.kill('SIGTERM');
    await waitUntil('master quit', () => master.exitCode != null, 8000);
    const slaveDuring = JSON.parse(await uiText(slaveUi));
    record(
      'slave stays open after the master disconnects',
      slave.exitCode == null && (slaveDuring.conn === 'Listening' || slaveDuring.conn.indexOf('Paired') === 0),
      slaveDuring.conn
    );
    masterAgain = launch('master', port, masterData, 9257, false);
    masterUiAgain = await attach(9257);
    await waitUntil('master reconnects by itself', async () => {
      const text = JSON.parse(await uiText(masterUiAgain));
      return text.conn === 'Paired';
    }, 15000);
    const pingAgain = await masterUiAgain.evaluate(`(async () => {
      const result = await window.electronAPI.link.ping();
      return !!(result && result.ok);
    })()`);
    const slaveAfter = await slaveUi.evaluate(`(async () => (await window.electronAPI.link.snapshot()).snapshot.identity.deviceId)()`);
    record(
      'reopened master reconnects without a new approval or a new identity',
      pingAgain === true && slaveAfter === slaveBefore && slave.exitCode == null,
      `ping=${pingAgain} id=${slaveAfter === slaveBefore}`
    );

    await masterUiAgain.evaluate(`(async () => window.electronAPI.link.unpair())()`);
    await sleep(300);
    masterUiAgain.evaluate(`(() => { requestSlavePairing(); return true; })()`);
    await waitUntil('second request', async () => popupShown(JSON.parse(await uiText(slaveUi))), 10000);
    await slaveUi.evaluate(`document.querySelector('#connectionRequestPopup .btn:not(.primary)').click()`);
    await sleep(400);
    const afterReject = JSON.parse(await uiText(slaveUi));
    record(
      'reject keeps both apps open',
      slave.exitCode == null && masterAgain.exitCode == null && afterReject.popup === '' && afterReject.conn !== 'Paired',
      afterReject.conn + ' ' + (slave.log().match(/uncaught|EPIPE/i) || []).join(',')
    );
    masterUiAgain.evaluate(`(() => { requestSlavePairing(); return true; })()`);
    await waitUntil('repeated request', async () => popupShown(JSON.parse(await uiText(slaveUi))), 10000);
    await slaveUi.evaluate(`document.querySelector('#connectionRequestPopup .btn.primary').click()`);
    await waitUntil('repeated accept pairs', async () => {
      const left = JSON.parse(await uiText(slaveUi));
      const right = JSON.parse(await uiText(masterUiAgain));
      return left.conn === 'Paired' && right.conn === 'Paired' && left.popup === '';
    }, 10000);
    record('a repeated request can be accepted', slave.exitCode == null && masterAgain.exitCode == null);
    await masterUiAgain.evaluate(`(async () => window.electronAPI.link.unpair())()`);
    await sleep(300);
    masterUiAgain.evaluate(`(() => {
      document.getElementById('slaveHost').value = '127.0.0.1';
      document.getElementById('slavePort').value = '47711';
      requestSlavePairing();
      return true;
    })()`);
    await waitUntil('unavailable slave', async () => {
      const text = JSON.parse(await uiText(masterUiAgain));
      return text.status === 'Slave unavailable' && text.conn === 'Slave unavailable';
    }, 8000);
    const unavailable = JSON.parse(await uiText(masterUiAgain));
    const slaveStill = JSON.parse(await uiText(slaveUi));
    record(
      'a closed address shows Slave unavailable',
      unavailable.status === 'Slave unavailable' &&
        unavailable.conn === 'Slave unavailable' &&
        slaveStill.popup === '' &&
        slave.exitCode == null,
      unavailable.status + ' / ' + unavailable.conn
    );
    const held = await portFree(port);
    record('slave did not open a second listener', held === false);

  } finally {
    if (slaveUi) slaveUi.close();
    if (masterUi) masterUi.close();
    if (masterUiAgain) masterUiAgain.close();
    stopApp(masterAgain);
    stopApp(master);
    stopApp(slave);
  }
}

async function main() {
  try {
    await unit();
  } catch (error) {
    record('connection unit flow', false, error.stack || error.message);
  }
  try {
    await apps();
  } catch (error) {
    record('connection app flow', false, error.stack || error.message);
  }
  const failed = results.filter((item) => !item.ok);
  if (crashes.length) {
    console.error('CRASHES');
    for (const crash of crashes) console.error(crash);
  }
  console.log(`\n${results.length - failed.length}/${results.length} connection checks passed`);
  process.exit(failed.length === 0 && crashes.length === 0 ? 0 : 1);
}

main();
