/**
 * Master crash and Sync, with two real playback engines.
 *
 * The Slave keeps playing when the Master dies. A restarted Master only
 * watches; Sync starts the Master exactly where the Slave is and hands control
 * back, without touching the Slave. The Slave's clock is deliberately offset so
 * the clock-offset arithmetic is exercised, not just a shared clock.
 */
process.env.PLAYOUT_MUTE = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayerSession } = require('../player-session');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { monotonicNow, sharedNow } = require('../link/clock-sync');

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

async function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(40);
  }
  return !!(await check());
}

function writeTone(file, seconds) {
  const rate = 22050;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
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

async function engineState(session) {
  const reply = await session.send('getState', {}, 5000);
  return reply && reply.state ? reply.state : {};
}

/** Positions of both engines projected to one host instant (same Mac). */
async function measuredDriftMs(masterSession, slaveSession) {
  const [m, s] = await Promise.all([engineState(masterSession), engineState(slaveSession)]);
  if (m.status !== 'playing' || s.status !== 'playing') return null;
  const at = Math.max(m.hostTime, s.hostTime);
  const mp = m.position + (at - m.hostTime) * (m.rate || 1);
  const sp = s.position + (at - s.hostTime) * (s.rate || 1);
  return (mp - sp) * 1000;
}

/** Slave position, projected forward, must never jump: proof nobody touched it. */
function continuity(before, after) {
  const elapsed = after.hostTime - before.hostTime;
  return Math.abs((after.position - before.position) - elapsed * (before.rate || 1));
}

const SLAVE_SKEW_MS = 123456.789;
const skewedClock = {
  monotonicNow: () => monotonicNow() + SLAVE_SKEW_MS,
  sharedNow
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-failover-'));
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  for (const root of [masterMedia, slaveMedia]) fs.mkdirSync(path.join(root, 'Set'), { recursive: true });
  for (const name of ['a.wav', 'b.wav']) {
    writeTone(path.join(masterMedia, 'Set', name), 90);
    writeTone(path.join(slaveMedia, 'Set', name), 90);
  }
  // only.wav exists on the Slave alone.
  writeTone(path.join(slaveMedia, 'Set', 'only.wav'), 90);
  const masterA = path.join(masterMedia, 'Set', 'a.wav');
  const masterB = path.join(masterMedia, 'Set', 'b.wav');
  const playlist = [
    { path: masterA, name: 'a.wav', type: 'audio', duration: 90 },
    { path: masterB, name: 'b.wav', type: 'audio', duration: 90 }
  ];

  const masterCfgPath = path.join(dir, 'master.json');
  const masterCfg = new ConfigStore(masterCfgPath);
  masterCfg.setRole('master');
  masterCfg.setMediaRoot(masterMedia);
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  slaveCfg.setRole('slave');
  slaveCfg.setMediaRoot(slaveMedia);

  const slaveSession = new PlayerSession();
  slaveSession.start();
  await engineState(slaveSession);
  const slave = new LinkController(slaveSession, {
    config: slaveCfg, clock: skewedClock, pairRetryDelayMs: 40, silenceMs: 1500
  });
  await slave.setRole('slave');
  await slave.listen(0);
  slave.on('event', (event) => {
    if (event && event.event === 'pair-request') slave.acceptPairing(event.requestId);
  });
  let sessionSyncs = 0;
  slave.server.on('session-sync', () => { sessionSyncs += 1; });

  let masterSession = null;
  let master = null;
  async function startMaster() {
    masterSession = new PlayerSession();
    masterSession.start();
    await engineState(masterSession);
    master = new LinkController(masterSession, {
      config: new ConfigStore(masterCfgPath), pairRetryDelayMs: 40, heartbeatMs: 300, observePollMs: 200
    });
    master.on('event', (event) => {
      if (event && event.event === 'session') master.lastSessionEvent = event.session;
    });
    await master.setRole('master');
  }
  async function crashMaster() {
    await master.shutdown();
    await masterSession.shutdown();
    await waitFor(() => slave.masterConnected === false, 4000);
  }

  try {
    // 1. Normal playout.
    await startMaster();
    const paired = await master.requestPairing('127.0.0.1', slave.listenPort);
    record('master pairs with slave', paired.ok === true, paired.error);
    record('a fresh master with an idle slave is in control', !master.observing, JSON.stringify(master.observing));
    await masterSession.send('load', { path: masterA }, 10000);
    master.publishSession({ playlist, currentIndex: 0, playAll: false });
    await master.mirrorLoad(masterA);
    await masterSession.send('play');
    await master.mirrorCommand('play', { state: 'playing', position: 0 });
    await waitFor(async () => (await engineState(slaveSession)).status === 'playing', 4000);
    await sleep(1500);

    // 2. Master crashes: Slave keeps playing, untouched, and unlocks.
    const beforeCrash = await engineState(slaveSession);
    await crashMaster();
    await sleep(1200);
    const afterCrash = await engineState(slaveSession);
    record('slave keeps playing after the master crashes', afterCrash.status === 'playing' && /a\.wav$/.test(afterCrash.path),
      `${afterCrash.status} ${path.basename(afterCrash.path || '')}`);
    record('slave playback is continuous through the crash', continuity(beforeCrash, afterCrash) < 0.1,
      `${(continuity(beforeCrash, afterCrash) * 1000).toFixed(1)} ms jump`);
    record('slave is released (unlocked) when the master dies', slave.masterConnected === false);

    // 3. Master restarts: it only watches.
    const syncsBefore = sessionSyncs;
    await startMaster();
    const restarted = await master.startPairedSession();
    record('restarted master reconnects', restarted.ok === true, restarted.error);
    record('restarted master watches the on-air slave', master.observing && master.observing.name === 'a.wav' &&
      master.observing.state === 'playing' && master.observing.count === 2 && master.observing.index === 0,
      JSON.stringify(master.observing));
    master.publishSession({ playlist: [], currentIndex: null, playAll: false });
    const refusedStop = await master.mirrorCommand('stop');
    const refusedLoad = await master.mirrorLoad(masterB);
    await sleep(600);
    record('a watching master sends no session to the slave', sessionSyncs === syncsBefore, `${sessionSyncs - syncsBefore} sent`);
    record('a watching master refuses transport and loads',
      refusedStop.ok === false && refusedStop.error.code === 'OBSERVING' && refusedLoad.ok === false && refusedLoad.error.code === 'OBSERVING');
    const p1 = master.observing.position;
    await sleep(700);
    record('the watched position keeps updating', master.observing && master.observing.position > p1 + 0.3,
      `${p1.toFixed(2)} → ${master.observing && master.observing.position.toFixed(2)}`);
    const watched = await engineState(slaveSession);
    record('slave still continuous after the master rejoined', watched.status === 'playing' && continuity(afterCrash, watched) < 0.1,
      `${(continuity(afterCrash, watched) * 1000).toFixed(1)} ms jump`);

    // 4. Sync.
    const beforeSync = await engineState(slaveSession);
    const synced = await master.syncWithSlave();
    record('sync succeeds', synced.ok === true && !synced.warning, JSON.stringify(synced.error || synced.warning || ''));
    record('sync reports the master within 20 ms of the slave', synced.driftMs != null && Math.abs(synced.driftMs) <= 20,
      `${synced.driftMs == null ? 'none' : synced.driftMs.toFixed(1)} ms`);
    const drifts = [];
    for (let i = 0; i < 5; i += 1) {
      drifts.push(await measuredDriftMs(masterSession, slaveSession));
      await sleep(200);
    }
    const worst = Math.max(...drifts.map((d) => (d == null ? Infinity : Math.abs(d))));
    record('independently measured drift stays within 20 ms', worst <= 20, drifts.map((d) => d == null ? 'x' : d.toFixed(1)).join(', ') + ' ms');
    const afterSync = await engineState(slaveSession);
    record('sync never touched the slave', continuity(beforeSync, afterSync) < 0.1,
      `${(continuity(beforeSync, afterSync) * 1000).toFixed(1)} ms jump`);
    record('master is in control after sync', !master.observing && master.slaveMediaStatus === 'ready');
    const adopted = master.lastSessionEvent;
    record('master adopts the slave playlist and item',
      adopted && adopted.playlist.length === 2 && adopted.playlist[0].path === masterA && adopted.currentIndex === 0,
      JSON.stringify(adopted && { n: adopted.playlist.length, first: adopted.playlist[0] && adopted.playlist[0].path, index: adopted.currentIndex }));

    // 5. After sync the master drives the slave again.
    await masterSession.send('pause');
    const paused = await master.mirrorCommand('pause', { state: 'paused' });
    await sleep(200);
    const slavePaused = await engineState(slaveSession);
    record('pause from the synced master reaches the slave', paused.ok && slavePaused.status === 'paused', slavePaused.status);

    // 6. Slave paused when the master dies: Sync leaves both paused at one point.
    await crashMaster();
    await startMaster();
    await master.startPairedSession();
    record('restarted master watches a paused slave', master.observing && master.observing.state === 'paused',
      JSON.stringify(master.observing));
    const pausedSync = await master.syncWithSlave();
    const mp = await engineState(masterSession);
    const sp = await engineState(slaveSession);
    record('sync with a paused slave leaves the master paused at the same point',
      pausedSync.ok && mp.status === 'paused' && Math.abs(mp.position - sp.position) < 0.05 && sp.status === 'paused',
      `${mp.status}@${mp.position.toFixed(3)} vs ${sp.status}@${sp.position.toFixed(3)}`);
    await masterSession.send('stop');
    const stopped = await master.mirrorCommand('stop');
    await sleep(200);
    record('stop from the synced master stops the slave', stopped.ok && (await engineState(slaveSession)).status === 'stopped');

    // 7. Slave on air with a file this master does not have.
    await crashMaster();
    await slaveSession.send('load', { path: path.join(slaveMedia, 'Set', 'only.wav') }, 10000);
    await slaveSession.send('play');
    // Same Mac in this test: move the file so this Master cannot find it by
    // path either, as on a real Master that lacks it. The open file keeps playing.
    fs.renameSync(path.join(slaveMedia, 'Set', 'only.wav'), path.join(dir, 'only-moved.wav'));
    await startMaster();
    await master.startPairedSession();
    const missing = await master.syncWithSlave();
    record('sync with a file missing here still takes control and says why',
      missing.ok && /not on this Mac/.test(missing.warning || '') && !master.observing,
      missing.warning || JSON.stringify(missing.error));
    const stopOnly = await master.mirrorCommand('stop');
    await sleep(200);
    record('the master can then stop the slave', stopOnly.ok && (await engineState(slaveSession)).status === 'stopped',
      JSON.stringify(stopOnly.error || ''));

    // 8. An idle slave never puts a restarted master into watching.
    await crashMaster();
    await startMaster();
    await master.startPairedSession();
    record('a restarted master with an idle slave is in control', !master.observing, JSON.stringify(master.observing));

    // 9. A master that goes silent without closing TCP is dropped by the slave.
    await waitFor(() => slave.masterConnected === true, 3000);
    await sleep(1000);
    master._stopHeartbeat();
    const dropped = await waitFor(() => slave.masterConnected === false, 4000);
    record('slave drops a silent master and unlocks', dropped);
  } finally {
    if (master) await master.shutdown().catch(() => {});
    if (masterSession) await masterSession.shutdown().catch(() => {});
    await slave.shutdown().catch(() => {});
    await slaveSession.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  record('no uncaught errors', crashes.length === 0, crashes[0]);
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} failover checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
