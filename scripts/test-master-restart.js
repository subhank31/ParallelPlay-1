/**
 * A Master that restarts or reconnects must never disturb a Slave that is
 * playing. An idle Slave still adopts the Master's playback when it joins.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(20);
  }
  return check();
}

function playbackCommands(commands) {
  return commands
    .filter((c) => ['load', 'play', 'pause', 'stop', 'seek', 'setRate'].includes(c.type))
    .map((c) => c.type);
}

async function startMaster(configPath, player) {
  const master = new LinkController(player, { config: new ConfigStore(configPath), pairRetryDelayMs: 40 });
  await master.setRole('master');
  return master;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-restart-'));
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  for (const root of [masterMedia, slaveMedia]) {
    fs.mkdirSync(path.join(root, 'Bhajans'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Bhajans', 'one.mp3'), 'audio-one');
    fs.writeFileSync(path.join(root, 'Bhajans', 'two.mp3'), 'audio-two');
  }
  const masterOne = path.join(masterMedia, 'Bhajans', 'one.mp3');
  const masterTwo = path.join(masterMedia, 'Bhajans', 'two.mp3');
  const slaveOne = path.join(slaveMedia, 'Bhajans', 'one.mp3');
  const playlist = [
    { path: masterOne, name: 'one.mp3', type: 'audio', duration: 12 },
    { path: masterTwo, name: 'two.mp3', type: 'audio', duration: 12 }
  ];

  const masterCfgPath = path.join(dir, 'm.json');
  const masterCfg = new ConfigStore(masterCfgPath);
  masterCfg.setRole('master');
  masterCfg.setMediaRoot(masterMedia);
  const slaveCfg = new ConfigStore(path.join(dir, 's.json'));
  slaveCfg.setRole('slave');
  slaveCfg.setMediaRoot(slaveMedia);

  const slavePlayer = new RecordingPlayer();
  const slave = new LinkController(slavePlayer, { config: slaveCfg, pairRetryDelayMs: 40 });
  await slave.setRole('slave');
  await slave.listen(0);
  slave.on('event', (event) => {
    if (event && event.event === 'pair-request') slave.acceptPairing(event.requestId);
  });
  let sessionSyncs = 0;
  slave.server.on('session-sync', () => { sessionSyncs += 1; });
  const slaveEvents = [];
  slave.on('event', (event) => slaveEvents.push(event && event.event));

  // 1. Normal start: pair, publish, play on both.
  let masterPlayer = new RecordingPlayer();
  let master = await startMaster(masterCfgPath, masterPlayer);
  const paired = await master.requestPairing('127.0.0.1', slave.listenPort);
  record('master pairs with slave', paired.ok === true, paired.error);
  await masterPlayer.send('load', { path: masterOne });
  await masterPlayer.send('play');
  master.publishSession({ playlist, currentIndex: 0, playAll: true });
  const load = await master.mirrorLoad(masterOne);
  const play = await master.mirrorCommand('play', { state: 'playing' });
  record('slave playing after mirrored load and play', load.ok && play.ok && slavePlayer.state.status === 'playing',
    `${slavePlayer.state.status} ${JSON.stringify(load.error || play.error || '')}`);
  await wait(300);

  // 2. Repeated identical publishes must not flood the slave.
  const syncsBefore = sessionSyncs;
  for (let i = 0; i < 20; i += 1) master.publishSession({ playlist, currentIndex: 0, playAll: true });
  await wait(400);
  record('20 identical publishes send no further sessionSync', sessionSyncs === syncsBefore,
    `${sessionSyncs - syncsBefore} sent`);
  master.publishSession({ playlist, currentIndex: 1, playAll: true });
  await waitFor(() => sessionSyncs > syncsBefore, 2000);
  record('a changed playlist index is still published', sessionSyncs === syncsBefore + 1,
    `${sessionSyncs - syncsBefore} sent`);
  await wait(300);

  // 3. Master crashes and restarts with an idle player.
  const beforeCrash = slavePlayer.commands.length;
  await master.shutdown();
  await waitFor(() => slave.masterConnected === false, 3000);
  masterPlayer = new RecordingPlayer();
  master = await startMaster(masterCfgPath, masterPlayer);
  const restarted = await master.startPairedSession();
  record('restarted master reconnects automatically', restarted.ok === true, restarted.error);
  await waitFor(() => slaveEvents.includes('authorized'), 3000);
  await wait(1200);
  const afterRestart = playbackCommands(slavePlayer.commands.slice(beforeCrash));
  record('restarted idle master sends no playback command to the slave', afterRestart.length === 0,
    afterRestart.join(',') || 'none');
  record('slave is still playing after master restart', slavePlayer.state.status === 'playing',
    slavePlayer.state.status);
  record('no stop error shown on the slave', !slaveEvents.includes('session-error'),
    slaveEvents.filter((e) => e === 'session-error').length + ' errors');

  // 4. Network blip: master comes back playing the same item, slightly ahead.
  const beforeBlip = slavePlayer.commands.length;
  await master.shutdown();
  await waitFor(() => slave.masterConnected === false, 3000);
  masterPlayer = new RecordingPlayer();
  await masterPlayer.send('load', { path: masterOne });
  await masterPlayer.send('seek', { seconds: 3.4 });
  await masterPlayer.send('play');
  master = await startMaster(masterCfgPath, masterPlayer);
  master.publishSession({ playlist, currentIndex: 0, playAll: true });
  await master.startPairedSession();
  await wait(1200);
  const afterBlip = playbackCommands(slavePlayer.commands.slice(beforeBlip));
  record('reconnecting playing master does not seek or reload the slave', afterBlip.length === 0,
    afterBlip.join(',') || 'none');

  // 5. Paused slave is not touched either.
  await slavePlayer.send('pause');
  const beforePaused = slavePlayer.commands.length;
  await master.shutdown();
  await waitFor(() => slave.masterConnected === false, 3000);
  masterPlayer = new RecordingPlayer();
  master = await startMaster(masterCfgPath, masterPlayer);
  await master.startPairedSession();
  await wait(1200);
  const afterPaused = playbackCommands(slavePlayer.commands.slice(beforePaused));
  record('restarted master leaves a paused slave paused', afterPaused.length === 0 && slavePlayer.state.status === 'paused',
    `${afterPaused.join(',') || 'none'} / ${slavePlayer.state.status}`);

  // 6. An idle slave still adopts a playing master when the link comes up.
  await slavePlayer.send('stop');
  slavePlayer.state = { status: 'idle', position: 0, duration: 0, rate: 1, path: null };
  const beforeJoin = slavePlayer.commands.length;
  await master.shutdown();
  await waitFor(() => slave.masterConnected === false, 3000);
  masterPlayer = new RecordingPlayer();
  await masterPlayer.send('load', { path: masterOne });
  await masterPlayer.send('seek', { seconds: 2 });
  await masterPlayer.send('play');
  master = await startMaster(masterCfgPath, masterPlayer);
  master.publishSession({ playlist, currentIndex: 0, playAll: true });
  await master.startPairedSession();
  await waitFor(() => slavePlayer.state.status === 'playing', 3000);
  const joined = playbackCommands(slavePlayer.commands.slice(beforeJoin));
  record('idle slave adopts the playing master on connect',
    slavePlayer.state.status === 'playing' && slavePlayer.state.path === slaveOne && joined.includes('load'),
    `${joined.join(',')} / ${slavePlayer.state.status}`);

  await master.shutdown();
  await slave.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} master restart checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
