const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');
const PlaylistUI = require('../playlist-ui');

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

function once(emitter, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitUntil(label, predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timeout: ${label}`);
}

function transport(commands) {
  return commands
    .map((command) => command.type)
    .filter((type) => type === 'load' || type === 'play' || type === 'pause' || type === 'stop' || type === 'seek');
}

async function pair(master, slave) {
  const incoming = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pair request did not arrive')), 8000);
    const onEvent = (event) => {
      if (!event || event.event !== 'pair-request') return;
      clearTimeout(timer);
      slave.off('event', onEvent);
      resolve(event);
    };
    slave.on('event', onEvent);
  });
  const pairing = master.requestPairing('127.0.0.1', slave.listenPort);
  const asked = await incoming;
  slave.acceptPairing(asked.requestId);
  const paired = await pairing;
  if (!paired.ok) throw new Error(paired.error || 'pairing failed');
}

function armSlave(slave, player, files, current) {
  player.state = {
    status: 'playing',
    position: 8,
    duration: 20,
    rate: 1,
    path: current
  };
  slave.peerRuntime = {
    sessionId: 'session-playing',
    playlist: files,
    playlistKnown: true,
    currentIndex: 1,
    playAll: true
  };
}

async function main() {
  const projected = PlaylistUI.projectPlaybackPosition({
    state: 'playing',
    position: 10,
    rate: 1,
    duration: 30,
    sampledAt: 1000,
    now: 5000,
    offsetMs: 0
  });
  const shifted = PlaylistUI.projectPlaybackPosition({
    state: 'playing',
    position: 10,
    rate: 1,
    duration: 30,
    sampledAt: 1000,
    now: 5000,
    offsetMs: 100
  });
  const held = PlaylistUI.projectPlaybackPosition({
    state: 'paused',
    position: 10,
    rate: 1,
    duration: 30,
    sampledAt: 1000,
    now: 9000,
    offsetMs: 0
  });
  record(
    'position follows the shared offset while playing and holds while paused',
    projected === 14 && Math.abs(shifted - 14.1) < 0.0001 && held === 10,
    `playing=${projected} offset=${shifted} paused=${held}`
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-failover-'));
  const alpha = path.join(dir, 'Alpha.wav');
  const beta = path.join(dir, 'Beta.wav');
  fs.writeFileSync(alpha, Buffer.alloc(64));
  fs.writeFileSync(beta, Buffer.alloc(64));
  const files = [
    { path: alpha, name: 'Alpha.wav', type: 'audio', duration: 20 },
    { path: beta, name: 'Beta.wav', type: 'audio', duration: 20 }
  ];

  async function openPair() {
    const masterCfg = new ConfigStore(path.join(dir, `master-${Date.now()}-${Math.random()}.json`));
    const slaveCfg = new ConfigStore(path.join(dir, `slave-${Date.now()}-${Math.random()}.json`));
    masterCfg.setRole('master');
    masterCfg.setMediaRoot(dir);
    slaveCfg.setRole('slave');
    slaveCfg.setMediaRoot(dir);
    const slavePlayer = new RecordingPlayer();
    const slave = new LinkController(slavePlayer, { config: slaveCfg });
    await slave.setRole('slave');
    const listening = await slave.listen(0);
    if (!listening.ok) throw new Error(listening.error || 'slave did not listen');
    const masterPlayer = new RecordingPlayer();
    const master = new LinkController(masterPlayer, { config: masterCfg });
    await master.setRole('master');
    await pair(master, slave);
    return { master, slave, slavePlayer, masterPlayer, masterCfg, slaveCfg, port: slave.listenPort };
  }

  const first = await openPair();
  armSlave(first.slave, first.slavePlayer, files, beta);
  const slaveCommandsAtPlay = first.slavePlayer.commands.length;
  await first.master.shutdown();
  await sleep(200);
  record(
    'master quit leaves the slave playing',
    first.slavePlayer.state.status === 'playing' &&
      first.slavePlayer.state.position === 8 &&
      first.slavePlayer.state.path === beta &&
      transport(first.slavePlayer.commands.slice(slaveCommandsAtPlay)).length === 0,
    `status=${first.slavePlayer.state.status} added=${transport(first.slavePlayer.commands.slice(slaveCommandsAtPlay)).join(',')}`
  );

  const reopenedPlayer = new RecordingPlayer();
  const reopened = new LinkController(reopenedPlayer, { config: first.masterCfg });
  await reopened.setRole('master');
  const sessionEvent = once(reopened, 'event', 8000).then(() => null);
  const events = [];
  reopened.on('event', (event) => {
    if (event && event.event === 'session') events.push(event.session);
  });
  const started = await reopened.startPairedSession();
  await sessionEvent.catch(() => null);
  await waitUntil('master adopted slave', () => reopenedPlayer.state.status === 'playing' && reopenedPlayer.state.path === beta);
  const adopted = events.filter((session) => session && session.currentIndex === 1).pop();
  const slaveAdded = transport(first.slavePlayer.commands.slice(slaveCommandsAtPlay));
  const seek = reopenedPlayer.commands.filter((command) => command.type === 'seek').pop();
  record(
    'reopened master adopts the slave and does not reset it',
    started.ok === true &&
      slaveAdded.length === 0 &&
      first.slavePlayer.state.status === 'playing' &&
      first.slavePlayer.state.position === 8 &&
      reopenedPlayer.state.path === beta &&
      seek && seek.fields.seconds >= 7 && seek.fields.seconds < 20 &&
      adopted && adopted.currentIndex === 1 &&
      adopted.playlist.map((entry) => entry.name).join(',') === 'Alpha.wav,Beta.wav' &&
      adopted.playAll === true &&
      adopted.sessionId === 'session-playing',
    `slave=[${slaveAdded.join(',')}] seek=${seek && seek.fields.seconds} index=${adopted && adopted.currentIndex}`
  );

  const crash = await openPair();
  armSlave(crash.slave, crash.slavePlayer, files, beta);
  const crashMark = crash.slavePlayer.commands.length;
  if (crash.master.client.socket) crash.master.client.socket.destroy();
  await sleep(100);
  await crash.master.shutdown();
  await sleep(150);
  record(
    'master crash leaves the slave playing',
    crash.slavePlayer.state.status === 'playing' &&
      crash.slavePlayer.state.position === 8 &&
      transport(crash.slavePlayer.commands.slice(crashMark)).indexOf('stop') === -1 &&
      transport(crash.slavePlayer.commands.slice(crashMark)).indexOf('load') === -1,
    transport(crash.slavePlayer.commands.slice(crashMark)).join(',') || 'no transport'
  );
  const crashedBack = new LinkController(new RecordingPlayer(), { config: crash.masterCfg });
  await crashedBack.setRole('master');
  await crashedBack.startPairedSession();
  await waitUntil('crashed master recovered', () => crashedBack.player.state.path === beta && crashedBack.player.state.status === 'playing');
  record(
    'reopened master after a crash does not stop the slave',
    crash.slavePlayer.state.status === 'playing' &&
      crash.slavePlayer.state.position === 8 &&
      transport(crash.slavePlayer.commands.slice(crashMark)).indexOf('stop') === -1,
    `slave=${crash.slavePlayer.state.status} pos=${crash.slavePlayer.state.position}`
  );

  const sleepCase = await openPair();
  armSlave(sleepCase.slave, sleepCase.slavePlayer, files, beta);
  const sleepMark = sleepCase.slavePlayer.commands.length;
  const slaveWake = await sleepCase.slave.recoverAfterWake();
  record(
    'slave sleep keeps its own playback when it is still playing',
    slaveWake.kept === true &&
      sleepCase.slavePlayer.state.status === 'playing' &&
      transport(sleepCase.slavePlayer.commands.slice(sleepMark)).indexOf('stop') === -1,
    `kept=${slaveWake.kept}`
  );
  sleepCase.masterPlayer.state = { status: 'idle', position: 0, duration: 0, rate: 1, path: null };
  const masterWakeMark = sleepCase.slavePlayer.commands.length;
  await sleepCase.master.recoverAfterWake();
  await waitUntil('sleeping master caught up', () => sleepCase.masterPlayer.state.path === beta);
  record(
    'master sleep recovers from the slave without stopping it',
    sleepCase.slavePlayer.state.status === 'playing' &&
      sleepCase.slavePlayer.state.position === 8 &&
      sleepCase.masterPlayer.state.status === 'playing' &&
      transport(sleepCase.slavePlayer.commands.slice(masterWakeMark)).indexOf('stop') === -1,
    `master=${sleepCase.masterPlayer.state.status} slaveAdded=${transport(sleepCase.slavePlayer.commands.slice(masterWakeMark)).join(',')}`
  );

  const reverse = await openPair();
  reverse.masterPlayer.state = {
    status: 'playing',
    position: 5.5,
    duration: 20,
    rate: 1,
    path: beta
  };
  reverse.master.publishedSession = {
    playlist: files,
    currentIndex: 1,
    playAll: true,
    published: true,
    sessionId: 'session-master'
  };
  const masterMark = reverse.masterPlayer.commands.length;
  await reverse.slave.shutdown();
  await sleep(100);
  record(
    'slave quit leaves the master playing',
    reverse.masterPlayer.state.status === 'playing' &&
      reverse.masterPlayer.state.position === 5.5 &&
      transport(reverse.masterPlayer.commands.slice(masterMark)).length === 0,
    `status=${reverse.masterPlayer.state.status}`
  );
  const revivedPlayer = new RecordingPlayer();
  const revived = new LinkController(revivedPlayer, { config: reverse.slaveCfg });
  await revived.setRole('slave');
  await revived.listen(reverse.port);
  await waitUntil('slave recovered from master', () => revivedPlayer.state.path === beta && revivedPlayer.state.status === 'playing');
  const masterAdded = transport(reverse.masterPlayer.commands.slice(masterMark));
  record(
    'reopened slave adopts the master and does not reset it',
    reverse.masterPlayer.state.status === 'playing' &&
      reverse.masterPlayer.state.position === 5.5 &&
      masterAdded.indexOf('stop') === -1 &&
      masterAdded.indexOf('load') === -1 &&
      revivedPlayer.state.path === beta &&
      revivedPlayer.state.position > 5 &&
      revived.peerRuntime.currentIndex === 1 &&
      revived.peerRuntime.sessionId === 'session-master',
    `master=[${masterAdded.join(',')}] slavePos=${revivedPlayer.state.position} index=${revived.peerRuntime.currentIndex}`
  );

  const slaveCrash = await openPair();
  slaveCrash.masterPlayer.state = {
    status: 'playing',
    position: 6,
    duration: 20,
    rate: 1,
    path: beta
  };
  slaveCrash.master.publishedSession = {
    playlist: files,
    currentIndex: 1,
    playAll: false,
    published: true,
    sessionId: 'session-crash-slave'
  };
  const slaveCrashMark = slaveCrash.masterPlayer.commands.length;
  if (slaveCrash.slave.server && slaveCrash.slave.server.client) slaveCrash.slave.server.client.destroy();
  await slaveCrash.slave.shutdown();
  await sleep(100);
  const slaveRevived = new LinkController(new RecordingPlayer(), { config: slaveCrash.slaveCfg });
  await slaveRevived.setRole('slave');
  await slaveRevived.listen(slaveCrash.port);
  await waitUntil('slave recovered after crash', () => slaveRevived.player.state.path === beta && slaveRevived.player.state.status === 'playing');
  record(
    'slave crash and reopen recovers from the master',
    slaveCrash.masterPlayer.state.status === 'playing' &&
      slaveCrash.masterPlayer.state.position === 6 &&
      transport(slaveCrash.masterPlayer.commands.slice(slaveCrashMark)).indexOf('stop') === -1 &&
      slaveRevived.player.state.position > 5 &&
      slaveRevived.peerRuntime.currentIndex === 1,
    `masterPos=${slaveCrash.masterPlayer.state.position} slavePos=${slaveRevived.player.state.position}`
  );

  const slowPlayer = new RecordingPlayer();
  const originalSend = slowPlayer.send.bind(slowPlayer);
  slowPlayer.send = (type, fields, timeout) => {
    if (type === 'getState') {
      return new Promise((resolve) => setTimeout(() => resolve(originalSend(type, fields, timeout)), 4000));
    }
    return originalSend(type, fields, timeout);
  };
  const slowCfg = new ConfigStore(path.join(dir, 'slow-slave.json'));
  const slowMasterCfg = new ConfigStore(path.join(dir, 'slow-master.json'));
  slowCfg.setRole('slave');
  slowMasterCfg.setRole('master');
  const slowSlave = new LinkController(slowPlayer, { config: slowCfg });
  await slowSlave.setRole('slave');
  await slowSlave.listen(0);
  const quickMaster = new LinkController(new RecordingPlayer(), { config: slowMasterCfg });
  await quickMaster.setRole('master');
  const linkStarted = Date.now();
  await pair(quickMaster, slowSlave);
  const linkMs = Date.now() - linkStarted;
  record(
    'a slow player does not block the connection',
    quickMaster.linkReady === true && quickMaster.snapshot().connection === 'connected' && linkMs < 1500,
    `${linkMs}ms`
  );
  await quickMaster.shutdown();
  await slowSlave.shutdown();

  await reopened.shutdown();
  await crashedBack.shutdown();
  await first.slave.shutdown();
  await crash.slave.shutdown();
  await sleepCase.master.shutdown();
  await sleepCase.slave.shutdown();
  await reverse.master.shutdown();
  await revived.shutdown();
  await slaveCrash.master.shutdown();
  await slaveRevived.shutdown();

  const failed = results.filter((item) => !item.ok);
  if (crashes.length) {
    console.error('CRASHES');
    for (const crash of crashes) console.error(crash);
  }
  console.log(`\n${results.length - failed.length}/${results.length} failover checks passed`);
  if (failed.length || crashes.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
