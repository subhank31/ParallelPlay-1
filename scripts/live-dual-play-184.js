const fs = require('fs');
const path = require('path');
const os = require('os');
const { MasterClient } = require('../link/master-client');
const { PlayerSession } = require('../player-session');

const HOST = '192.168.127.184';
const PORT = 47631;
const MEDIA_ABS = '/Volumes/1431/PlayoutMedia/Bhajans/Ganapati.mp4';
const MEDIA_REL = 'Bhajans/Ganapati.mp4';
const IDENTITY = {
  deviceId: 'b222b222-b222-4222-8222-b222b222b222',
  deviceName: 'Parallel Playout — Master 222',
  role: 'master'
};

function record(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSlave(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n += 1;
    const client = new MasterClient();
    try {
      await client.connect({ host: HOST, port: PORT });
      const ping = await client.request('ping', {}, 2000);
      if (ping && ping.ok) {
        client.disconnect();
        console.log(`Slave alive after ${n} polls`);
        return true;
      }
      client.disconnect();
    } catch (e) {
      try { client.disconnect(); } catch (_) {}
    }
    if (n % 5 === 0) console.log(`Waiting for Slave… (${n})`);
    await sleep(2000);
  }
  return false;
}

async function main() {
  let failed = 0;
  const check = (n, ok, d) => { if (!record(n, ok, d)) failed += 1; };

  console.log('Waiting for Slave 184 to speak Parallel Playout protocol…');
  console.log('If needed: on Slave Desktop double-click "RESTART Parallel Playout Slave.command"');
  const up = await waitForSlave(300000);
  check('Slave protocol alive', up);
  if (!up) process.exit(1);

  const master = new MasterClient();
  await master.connect({ host: HOST, port: PORT });
  check('TCP connected', master.connectionState === 'connected');

  // Pairing / auth
  const hello = await master.request('hello', IDENTITY, 8000);
  console.log('hello', JSON.stringify(hello));
  if (hello.ok && hello.payload && hello.payload.authorized) {
    check('paired auto-authorize', true);
  } else if (hello.ok && hello.payload && hello.payload.needsPairing) {
    // Pre-seeded pairing should have avoided this; try pairRequest won't work without UI
    check('paired auto-authorize', false, 'needs pairing UI');
  } else if (hello.error && hello.error.code === 'UNKNOWN_COMMAND') {
    check('legacy slave (no pairing)', true, 'will use absolute path');
  } else {
    check('hello', hello.ok, JSON.stringify(hello));
  }

  const authorized = hello.ok && hello.payload && hello.payload.authorized;
  const legacy = hello.error && hello.error.code === 'UNKNOWN_COMMAND';

  // Start local master player session for true dual play
  const session = new PlayerSession({ mute: true });
  session.on('log', (line) => console.error('[engine]', line));
  session.start();
  await sleep(1500);

  // Load local
  const localLoad = await session.send('load', { path: MEDIA_ABS }, 30000);
  check('MASTER local load', localLoad && localLoad.ok, localLoad && (localLoad.error || localLoad.state && localLoad.state.path));

  // Load slave
  let remoteLoad;
  if (!legacy) {
    remoteLoad = await master.request('load', { mediaPath: MEDIA_REL, source: 'master' }, 30000);
    if (!remoteLoad.ok) {
      remoteLoad = await master.request('load', { path: MEDIA_ABS, source: 'master' }, 30000);
    }
  } else {
    remoteLoad = await master.request('load', { path: MEDIA_ABS }, 30000);
  }
  check('SLAVE load Ganapati', remoteLoad && remoteLoad.ok, remoteLoad && (remoteLoad.error ? JSON.stringify(remoteLoad.error) : (remoteLoad.payload && (remoteLoad.payload.mediaPath || remoteLoad.payload.path || remoteLoad.payload.status && remoteLoad.payload.status.file))));

  // ONE CLICK PLAY — both systems
  console.log('\n=== ONE-CLICK PLAY (Master + Slave) ===');
  const remotePlayP = master.request('play', legacy ? {} : { source: 'master' }, 15000);
  const localPlayP = session.send('play', {}, 15000);
  const [remotePlay, localPlay] = await Promise.all([remotePlayP, localPlayP]);
  check('MASTER play', localPlay && localPlay.ok, localPlay && localPlay.state && localPlay.state.status);
  check('SLAVE play', remotePlay && remotePlay.ok, remotePlay && (remotePlay.error ? JSON.stringify(remotePlay.error) : remotePlay.payload && remotePlay.payload.status && remotePlay.payload.status.state));
  await sleep(1200);

  let st = await master.request('getStatus');
  check('SLAVE status playing', st.ok && st.payload.state === 'playing', JSON.stringify(st.payload));
  let localSt = await session.send('getState', {}, 5000);
  check('MASTER status playing', localSt && localSt.ok && localSt.state.status === 'playing', localSt && localSt.state && localSt.state.status);

  // Pause both
  await Promise.all([
    master.request('pause', legacy ? {} : { source: 'master' }),
    session.send('pause', {}, 10000)
  ]);
  st = await master.request('getStatus');
  check('SLAVE pause', st.ok && st.payload.state === 'paused', st.payload && st.payload.state);

  // Seek both
  await Promise.all([
    master.request('seek', legacy ? { seconds: 5 } : { seconds: 5, source: 'master' }),
    session.send('seek', { seconds: 5 }, 10000)
  ]);
  st = await master.request('getStatus');
  check('SLAVE seek ~5s', st.ok && Math.abs(Number(st.payload.position) - 5) < 1.5, st.payload && st.payload.position);

  // Rate both
  await Promise.all([
    master.request('setRate', legacy ? { rate: 1.5 } : { rate: 1.5, source: 'master' }),
    session.send('setRate', { rate: 1.5 }, 10000)
  ]);
  st = await master.request('getStatus');
  check('SLAVE rate 1.5x', st.ok && Number(st.payload.rate) === 1.5, st.payload && st.payload.rate);
  await master.request('setRate', legacy ? { rate: 1.0 } : { rate: 1.0, source: 'master' });
  await session.send('setRate', { rate: 1.0 }, 10000);

  // Play again then stop
  await Promise.all([
    master.request('play', legacy ? {} : { source: 'master' }),
    session.send('play', {}, 10000)
  ]);
  await sleep(500);
  if (!legacy) {
    const fsCmd = await master.request('fullscreen', { enabled: true, source: 'master' }, 10000);
    check('SLAVE fullscreen', fsCmd.ok !== false, JSON.stringify(fsCmd));
  }
  await Promise.all([
    master.request('stop', legacy ? {} : { source: 'master' }),
    session.send('stop', {}, 10000)
  ]);
  st = await master.request('getStatus');
  check('SLAVE stop', st.ok && (st.payload.state === 'stopped' || st.payload.state === 'paused'), st.payload && st.payload.state);

  master.disconnect();
  await session.shutdown();

  console.log(failed === 0 ? '\nALL DUAL-PLAY CHECKS PASSED' : `\n${failed} CHECKS FAILED`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
