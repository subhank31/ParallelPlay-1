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

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sync-'));
  const masterMedia = path.join(dir, 'master');
  const slaveMedia = path.join(dir, 'slave');
  fs.mkdirSync(path.join(masterMedia, 'Bhajans'), { recursive: true });
  fs.mkdirSync(path.join(slaveMedia, 'Bhajans'), { recursive: true });
  const file = path.join(masterMedia, 'Bhajans', 'track.mp3');
  fs.writeFileSync(file, 'audio-bytes-12345');
  fs.writeFileSync(path.join(slaveMedia, 'Bhajans', 'track.mp3'), 'audio-bytes-12345');

  const masterCfg = new ConfigStore(path.join(dir, 'm.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 's.json'));
  masterCfg.setRole('master');
  slaveCfg.setRole('slave');
  masterCfg.setMediaRoot(masterMedia);
  slaveCfg.setMediaRoot(slaveMedia);

  const masterPlayer = new RecordingPlayer();
  const slavePlayer = new RecordingPlayer();
  const master = new LinkController(masterPlayer, { config: masterCfg, pairRetryDelayMs: 40 });
  const slave = new LinkController(slavePlayer, { config: slaveCfg, pairRetryDelayMs: 40 });
  await master.setRole('master');
  await slave.setRole('slave');
  await slave.listen(0);
  const port = slave.listenPort;
  const pairing = master.requestPairing('127.0.0.1', port);
  await new Promise((resolve) => {
    slave.on('event', (event) => {
      if (event && event.event === 'pair-request') slave.acceptPairing(event.requestId);
    });
    pairing.then(resolve, resolve);
  });
  const paired = await pairing;
  record('paired for session sync', paired.ok === true, paired.error);

  master.publishSession({
    playlist: [{ path: file, name: 'track.mp3', type: 'audio', duration: 1 }],
    currentIndex: 0,
    playAll: false
  });
  await new Promise((r) => setTimeout(r, 300));
  const load = await master.mirrorLoad(file);
  record('mirror load after publish', load.ok === true, JSON.stringify(load.error));
  const play = await master.mirrorCommand('play', { state: 'playing' });
  record('mirror play', play.ok === true, JSON.stringify(play.error));
  record(
    'slave player received load',
    slavePlayer.commands.some((c) => c.type === 'load'),
    slavePlayer.commands.map((c) => c.type).join(',')
  );

  await master.shutdown();
  await slave.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} session sync checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
