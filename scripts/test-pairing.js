const fs = require('fs');
const os = require('os');
const path = require('path');
const { MasterClient } = require('../link/master-client');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { toRelativeMediaPath, resolveMediaPath } = require('../link/media-path');
const { execute } = require('../link/player-bridge');

const results = [];
const crashes = [];

process.on('uncaughtException', (error) => crashes.push(error.stack || String(error)));
process.on('unhandledRejection', (error) =>
  crashes.push(error && error.stack ? error.stack : String(error))
);

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pp-${label}-`));
}

function makeMediaLibrary(root) {
  fs.mkdirSync(path.join(root, 'Bhajans'), { recursive: true });
  const file = path.join(root, 'Bhajans', 'Ganapati.mp4');
  fs.writeFileSync(file, Buffer.alloc(64));
  return file;
}

function masterIdentity(config) {
  return {
    deviceId: config.data.deviceId,
    deviceName: config.data.deviceName,
    role: 'master'
  };
}

async function pairAcceptFlow() {
  const dir = tempDir('pair');
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Parallel Playout — Master');
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Parallel Playout — Slave');

  const player = new RecordingPlayer();
  const slave = new SlaveServer({
    player,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  const master = new MasterClient();

  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });

  const hello = await master.request('hello', masterIdentity(masterCfg));
  record(
    'unknown device hello does not authorize',
    hello.ok === true && hello.payload.authorized === false && hello.payload.needsPairing === true,
    JSON.stringify(hello.payload)
  );

  const requestPromise = once(slave, 'pair-request');
  const pairPromise = master.request('pairRequest', masterIdentity(masterCfg), 10000);
  const incoming = await requestPromise;
  record(
    'pairing request',
    incoming && incoming.deviceId === masterCfg.data.deviceId && !!incoming.requestId,
    incoming && incoming.deviceName
  );

  const accepted = slave.acceptPairing(incoming.requestId);
  const pairResponse = await pairPromise;
  record(
    'pairing acceptance',
    accepted.ok === true && pairResponse.ok === true && slaveCfg.getPaired()?.deviceId === masterCfg.data.deviceId,
    pairResponse.ok ? 'accepted' : JSON.stringify(pairResponse.error)
  );

  master.disconnect();
  await slave.stop();
  return { dir, masterCfg, slaveCfg, listening };
}

async function pairRejectFlow() {
  const dir = tempDir('reject');
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setDeviceName('Master A');
  slaveCfg.setDeviceName('Slave A');

  const player = new RecordingPlayer();
  const slave = new SlaveServer({
    player,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  const master = new MasterClient();
  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });

  const requestPromise = once(slave, 'pair-request');
  const pairPromise = master.request('pairRequest', masterIdentity(masterCfg), 10000);
  const incoming = await requestPromise;
  slave.rejectPairing(incoming.requestId);
  const response = await pairPromise;
  record(
    'pairing rejection',
    response.ok === false &&
      response.error &&
      response.error.code === 'PAIR_REJECTED' &&
      !slaveCfg.getPaired(),
    response.error && response.error.message
  );
  master.disconnect();
  await slave.stop();
}

async function persistenceAndReconnect() {
  const dir = tempDir('persist');
  const masterMedia = path.join(dir, 'master-media');
  const slaveMedia = path.join(dir, 'slave-media');
  makeMediaLibrary(masterMedia);
  makeMediaLibrary(slaveMedia);

  const masterCfgPath = path.join(dir, 'master.json');
  const slaveCfgPath = path.join(dir, 'slave.json');
  const masterCfg = new ConfigStore(masterCfgPath);
  const slaveCfg = new ConfigStore(slaveCfgPath);
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Master Persist');
  masterCfg.setMediaRoot(masterMedia);
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Slave Persist');
  slaveCfg.setMediaRoot(slaveMedia);

  const player = new RecordingPlayer();
  const slave = new SlaveServer({
    player,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  const master = new MasterClient();
  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });

  const incoming = once(slave, 'pair-request');
  const pairPromise = master.request('pairRequest', masterIdentity(masterCfg), 10000);
  const req = await incoming;
  slave.acceptPairing(req.requestId);
  await pairPromise;

  masterCfg.setPaired({
    deviceId: slaveCfg.data.deviceId,
    deviceName: slaveCfg.data.deviceName,
    role: 'slave',
    host: '127.0.0.1',
    port: listening.port,
    pairedAt: new Date().toISOString()
  });

  record(
    'pairing persistence (write)',
    !!masterCfg.getPaired() && !!slaveCfg.getPaired(),
    `master=${!!masterCfg.getPaired()} slave=${!!slaveCfg.getPaired()}`
  );

  // Simulate app restart by reloading config from disk.
  const masterReloaded = new ConfigStore(masterCfgPath);
  const slaveReloaded = new ConfigStore(slaveCfgPath);
  record(
    'pairing persistence (reload)',
    masterReloaded.getPaired()?.deviceId === slaveCfg.data.deviceId &&
      slaveReloaded.getPaired()?.deviceId === masterCfg.data.deviceId,
    'configs reloaded'
  );

  // Network disconnect then reconnect without new approval.
  master.disconnect();
  await sleep(50);

  const slave2 = new SlaveServer({
    player: new RecordingPlayer(),
    host: '127.0.0.1',
    config: slaveReloaded,
    enforcePairing: true
  });
  // Keep original slave listening — stop and reuse port via new server after stop.
  await slave.stop();
  const again = await slave2.start(listening.port);
  const master2 = new MasterClient();
  await master2.connect({ host: '127.0.0.1', port: again.port });
  const hello = await master2.request('hello', masterIdentity(masterReloaded));
  record(
    'same device can reconnect without approval',
    hello.ok === true && hello.payload.authorized === true && hello.payload.paired === true,
    JSON.stringify(hello.payload)
  );

  // Disconnect master — slave keeps listening.
  master2.disconnect();
  await sleep(50);
  record(
    'Slave continues listening while Master is offline',
    !!slave2.server && Number.isInteger(slave2.port),
    `port=${slave2.port}`
  );

  // Unknown device cannot play.
  const strangerCfg = new ConfigStore(path.join(dir, 'stranger.json'));
  strangerCfg.setDeviceName('Stranger');
  const stranger = new MasterClient();
  await stranger.connect({ host: '127.0.0.1', port: again.port });
  await stranger.request('hello', masterIdentity(strangerCfg));
  const denied = await stranger.request('play', { source: 'master' });
  record(
    'unknown device cannot issue playback commands',
    denied.ok === false && denied.error && denied.error.code === 'NOT_AUTHORIZED',
    denied.error && denied.error.code
  );
  stranger.disconnect();

  // Unpair
  const trusted = new MasterClient();
  await trusted.connect({ host: '127.0.0.1', port: again.port });
  await trusted.request('hello', masterIdentity(masterReloaded));
  const unpaired = await trusted.request('unpair', {});
  record('explicit unpair', unpaired.ok === true && !slaveReloaded.getPaired(), 'unpaired');
  trusted.disconnect();

  // After unpair, needs approval again.
  const againMaster = new MasterClient();
  await againMaster.connect({ host: '127.0.0.1', port: again.port });
  const hello2 = await againMaster.request('hello', masterIdentity(masterReloaded));
  record(
    'removed device requires new pairing',
    hello2.ok === true && hello2.payload.authorized === false && hello2.payload.needsPairing === true,
    JSON.stringify(hello2.payload)
  );
  againMaster.disconnect();
  await slave2.stop();
}

async function mediaPathTests() {
  const dir = tempDir('media');
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  const file = makeMediaLibrary(masterMedia);
  makeMediaLibrary(slaveMedia);

  const relative = toRelativeMediaPath(masterMedia, file);
  record(
    'relative media path resolution',
    relative.ok === true && relative.mediaPath === 'Bhajans/Ganapati.mp4',
    relative.ok ? relative.mediaPath : JSON.stringify(relative.error)
  );

  const resolved = resolveMediaPath(slaveMedia, 'Bhajans/Ganapati.mp4');
  record(
    'slave resolves same relative path',
    resolved.ok === true && resolved.absolutePath === path.join(slaveMedia, 'Bhajans', 'Ganapati.mp4'),
    resolved.ok ? resolved.absolutePath : JSON.stringify(resolved.error)
  );

  const traversal = resolveMediaPath(slaveMedia, '../etc/passwd.mp4');
  record(
    'path traversal rejection',
    traversal.ok === false && traversal.error.code === 'PATH_TRAVERSAL',
    traversal.error && traversal.error.code
  );

  const missing = resolveMediaPath(slaveMedia, 'Bhajans/Missing.mp4');
  record(
    'missing slave media',
    missing.ok === false &&
      missing.error.code === 'MEDIA_NOT_FOUND' &&
      /MEDIA NOT FOUND ON SLAVE/.test(missing.error.message),
    missing.error && missing.error.message.split('\n')[0]
  );
}

async function mirroredPlayback() {
  const dir = tempDir('mirror');
  const masterMedia = path.join(dir, 'master-media');
  const slaveMedia = path.join(dir, 'slave-media');
  const masterFile = makeMediaLibrary(masterMedia);
  makeMediaLibrary(slaveMedia);

  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Mirror Master');
  masterCfg.setMediaRoot(masterMedia);
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Mirror Slave');
  slaveCfg.setMediaRoot(slaveMedia);

  const player = new RecordingPlayer();
  const slave = new SlaveServer({
    player,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  const master = new MasterClient();
  const listening = await slave.start(0);

  // Pair via LinkController-style flow on master side using controller for mirror APIs.
  const localPlayer = new RecordingPlayer();
  const link = new LinkController(localPlayer, { config: masterCfg });
  await link.setRole('master');

  await master.connect({ host: '127.0.0.1', port: listening.port });
  const reqP = once(slave, 'pair-request');
  const pairP = master.request('pairRequest', masterIdentity(masterCfg), 10000);
  const req = await reqP;
  slave.acceptPairing(req.requestId);
  await pairP;
  masterCfg.setPaired({
    deviceId: slaveCfg.data.deviceId,
    deviceName: slaveCfg.data.deviceName,
    role: 'slave',
    host: '127.0.0.1',
    port: listening.port,
    pairedAt: new Date().toISOString()
  });
  // Hand the live client to the controller.
  link.autoReconnect = false;
  link._clearReconnect();
  link.client.disconnect();
  link.client = master;
  link.pairingState = 'paired';

  const load = await link.mirrorLoad(masterFile);
  record(
    'Master load mirrors to Slave',
    load.ok === true &&
      player.commands.some((c) => c.type === 'load' && c.fields.path.endsWith('Bhajans/Ganapati.mp4')),
    load.ok ? load.mediaPath : JSON.stringify(load.error)
  );

  const play = await link.mirrorCommand('play', { source: 'master' });
  record(
    'Master play mirrors to Slave',
    play.ok === true && player.commands.some((c) => c.type === 'play'),
    play.ok ? 'played' : JSON.stringify(play.error)
  );
  const firstPlay = player.commands.findIndex((c) => c.type === 'play');
  const firstFull = player.commands.findIndex((c) => c.type === 'fullscreen');
  record(
    'remote play causes Slave fullscreen before playback',
    firstFull >= 0 && firstPlay >= 0 && firstFull < firstPlay &&
      player.commands[firstFull].fields.enabled === true,
    player.commands.map((c) => c.type).join(',')
  );

  const pause = await link.mirrorCommand('pause', { source: 'master' });
  record('Master pause mirrors to Slave', pause.ok === true && player.state.status === 'paused');

  const seek = await link.mirrorCommand('seek', { seconds: 3.5, source: 'master' });
  record(
    'Master seek mirrors to Slave',
    seek.ok === true && player.state.position === 3.5,
    `pos=${player.state.position}`
  );

  const rate = await link.mirrorCommand('setRate', { rate: 1.5, source: 'master' });
  record(
    'Master rate mirrors to Slave',
    rate.ok === true && player.state.rate === 1.5,
    `rate=${player.state.rate}`
  );

  const stop = await link.mirrorCommand('stop', { source: 'master' });
  record('Master stop mirrors to Slave', stop.ok === true && player.state.status === 'stopped');

  // No feedback loop: slave execute must not invent master-bound commands.
  const before = player.commands.length;
  await execute(player, { type: 'play', requestId: 'x', payload: { source: 'master' }, source: 'master' }, {
    mediaRoot: slaveMedia
  });
  const afterTypes = player.commands.slice(before).map((c) => c.type);
  record(
    'no command feedback loop',
    afterTypes.includes('play') && !afterTypes.includes('fullscreen') && !afterTypes.includes('pairRequest'),
    afterTypes.join(',')
  );

  // Master works when Slave temporarily unavailable.
  master.disconnect();
  const offline = await link.mirrorCommand('play', { source: 'master' });
  record(
    'Master works when Slave temporarily unavailable',
    offline.ok === false && offline.error && offline.error.code === 'NOT_CONNECTED',
    offline.error && offline.error.code
  );

  link.client.disconnect();
  await slave.stop();
}

async function linkControllerReconnect() {
  const dir = tempDir('ctrl');
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Ctrl Master');
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Ctrl Slave');

  const slavePlayer = new RecordingPlayer();
  const slave = new SlaveServer({
    player: slavePlayer,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  const listening = await slave.start(0);

  const masterPlayer = new RecordingPlayer();
  const link = new LinkController(masterPlayer, { config: masterCfg });
  await link.setRole('master');

  const pairPromise = link.requestPairing('127.0.0.1', listening.port);
  const incoming = await once(slave, 'pair-request', 10000);
  slave.acceptPairing(incoming.requestId);
  const paired = await pairPromise;
  record(
    'LinkController pairing acceptance',
    paired.ok === true && masterCfg.getPaired() && slaveCfg.getPaired(),
    paired.ok ? 'paired' : paired.error
  );

  // Simulate disconnect and startPairedSession reconnect (app restart).
  link.client.disconnect();
  await sleep(30);
  const restarted = await link.startPairedSession();
  record(
    'reconnect after application restart',
    restarted.ok === true && link.client.connectionState === 'connected',
    restarted.ok ? 'reconnected' : restarted.error
  );

  // Network drop + auto reconnect
  link.autoReconnect = true;
  link.client.disconnect();
  let reconnected = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (link.client.connectionState === 'connected') {
      reconnected = true;
      break;
    }
    if (!link.reconnectTimer && link.client.connectionState !== 'connecting') {
      link._scheduleReconnect();
    }
  }
  record(
    'reconnect after network disconnect',
    reconnected === true,
    `state=${link.client.connectionState} reconnecting=${!!link.snapshot().reconnecting}`
  );

  await link.unpair();
  await slave.stop();
  await link.shutdown();
}

async function main() {
  await pairAcceptFlow();
  await pairRejectFlow();
  await persistenceAndReconnect();
  await mediaPathTests();
  await mirroredPlayback();
  await linkControllerReconnect();

  const failed = results.filter((r) => !r.ok);
  if (crashes.length) {
    console.error('CRASHES');
    for (const crash of crashes) console.error(crash);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length || crashes.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
