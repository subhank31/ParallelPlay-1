const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
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
    if (predicate()) return Date.now() - started;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pair(master, slave) {
  const request = once(slave, 'event').then(() => null);
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
  await request.catch(() => {});
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-reconnect-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  const first = path.join(media, 'Alpha.wav');
  const second = path.join(media, 'Beta.wav');
  fs.writeFileSync(first, Buffer.alloc(64));
  fs.writeFileSync(second, Buffer.alloc(64));
  const missing = path.join(media, 'Gamma-missing.wav');

  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Reconnect Master');
  masterCfg.setMediaRoot(media);
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Reconnect Slave');
  slaveCfg.setMediaRoot(media);

  const slave = new LinkController(new RecordingPlayer(), { config: slaveCfg });
  await slave.setRole('slave');
  const listening = await slave.listen(0);
  if (!listening.ok) throw new Error(listening.error || 'slave did not listen');
  const port = slave.listenPort;

  const master = new LinkController(new RecordingPlayer(), { config: masterCfg });
  await master.setRole('master');
  const case2Started = Date.now();
  await pair(master, slave);
  const case2Ms = Date.now() - case2Started;
  record(
    '2. slave open then master connects immediately',
    master.linkReady === true && master.snapshot().connection === 'connected' && case2Ms < 1500,
    `${case2Ms}ms`
  );

  master.player.state = {
    status: 'paused',
    path: second,
    position: 0,
    duration: 1,
    rate: 1
  };
  master.publishSession({
    playlist: [
      { path: first, name: 'Alpha.wav', type: 'audio', duration: 1 },
      { path: second, name: 'Beta.wav', type: 'audio', duration: 1 },
      { path: missing, name: 'Gamma-missing.wav', type: 'audio', duration: 1 }
    ],
    currentIndex: 1,
    playAll: true
  });
  let playlistEvent = null;
  slave.on('event', (event) => {
    if (event && event.event === 'session' && event.session) playlistEvent = event.session;
  });
  await slave.requestMasterSession();
  if (!playlistEvent) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  master.client.socket.destroy();
  const names = playlistEvent && playlistEvent.playlist ? playlistEvent.playlist.map((entry) => entry.name) : [];
  record(
    'slave shows the files loaded on the master',
    names.indexOf('Alpha.wav') >= 0 && names.indexOf('Beta.wav') >= 0 &&
      playlistEvent && playlistEvent.currentIndex === 1,
    names.join(', ') || 'no playlist event'
  );

  await master.shutdown();
  const masterAfterSlave = new LinkController(new RecordingPlayer(), { config: masterCfg });
  await masterAfterSlave.setRole('master');
  const immediate = Date.now();
  const started = await masterAfterSlave.startPairedSession();
  const immediateMs = Date.now() - immediate;
  record(
    '2b. master opened while slave is already listening',
    started.ok === true && masterAfterSlave.linkReady === true && immediateMs < 1500,
    `${immediateMs}ms ${started.ok ? 'connected' : started.error}`
  );

  await slave.stopListening();
  await sleep(100);
  await masterAfterSlave.shutdown();
  const masterFirst = new LinkController(new RecordingPlayer(), { config: masterCfg });
  await masterFirst.setRole('master');
  const early = await masterFirst.startPairedSession();
  record(
    '1. master stays open while slave is stopped',
    early.ok === false && masterFirst.sessionDesired === true && masterFirst.linkReady === false,
    early.error || masterFirst.snapshot().connection
  );
  const slaveAgain = await slave.listen(port);
  let case1Ms = 0;
  try {
    case1Ms = await waitUntil('slave started after master', () => masterFirst.linkReady === true && masterFirst.snapshot().connection === 'connected');
  } catch (error) {
    case1Ms = -1;
  }
  record(
    '1. master connects when slave opens',
    slaveAgain.ok === true && case1Ms >= 0 && masterFirst.linkReady === true,
    case1Ms >= 0 ? `${case1Ms}ms` : masterFirst.snapshot().connection
  );

  await slave.stopListening();
  await sleep(50);
  const held = new Set();
  const blackhole = net.createServer((socket) => {
    held.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => held.delete(socket));
  });
  await listen(blackhole, port);
  const stalled = Date.now();
  let becameReadyDuringBlackhole = false;
  while (Date.now() - stalled < 2500) {
    if (masterFirst.linkReady) becameReadyDuringBlackhole = true;
    await sleep(100);
  }
  for (const socket of held) socket.destroy();
  masterFirst.client.disconnect();
  await closeServer(blackhole);
  const revived = await slave.listen(port);
  let case3Ms = -1;
  try {
    case3Ms = await waitUntil('connection becomes available', () => masterFirst.linkReady === true);
  } catch (error) {
    case3Ms = -1;
  }
  record(
    '3. both already open and the connection becomes available',
    becameReadyDuringBlackhole === false && revived.ok === true && case3Ms >= 0,
    `stuck=${becameReadyDuringBlackhole} ${case3Ms}ms`
  );

  const dropped = once(masterFirst, 'event', 4000).catch(() => null);
  await slave.stopListening();
  let sawDisconnect = false;
  const dropStarted = Date.now();
  while (Date.now() - dropStarted < 4000) {
    if (!masterFirst.linkReady) {
      sawDisconnect = true;
      break;
    }
    await sleep(50);
  }
  void dropped;
  const returned = await slave.listen(port);
  let case4Ms = -1;
  try {
    case4Ms = await waitUntil('slave reconnects', () => masterFirst.linkReady === true && masterFirst.snapshot().connection === 'connected');
  } catch (error) {
    case4Ms = -1;
  }
  record(
    '4. slave disconnects and master reconnects',
    sawDisconnect === true && returned.ok === true && case4Ms >= 0,
    `dropped=${sawDisconnect} ${case4Ms}ms`
  );

  const stranger = new ConfigStore(path.join(dir, 'stranger.json'));
  stranger.setRole('master');
  stranger.setDeviceName('Stranger');
  const intruder = new LinkController(new RecordingPlayer(), { config: stranger });
  await intruder.setRole('master');
  const denied = await Promise.race([
    intruder.requestPairing('127.0.0.1', port),
    sleep(5000).then(() => ({ ok: false, error: 'intruder request timed out' }))
  ]);
  record(
    'unpaired master still cannot take the connection',
    denied.ok === false && masterFirst.linkReady === true,
    denied.error || 'intruder paired'
  );

  await intruder.shutdown();
  await masterFirst.shutdown();
  await masterAfterSlave.shutdown().catch(() => {});
  await slave.shutdown();

  const failed = results.filter((item) => !item.ok);
  if (crashes.length) {
    console.error('CRASHES');
    for (const crash of crashes) console.error(crash);
  }
  console.log(`\n${results.length - failed.length}/${results.length} reconnect checks passed`);
  if (failed.length || crashes.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
