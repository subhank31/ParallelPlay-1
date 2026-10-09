const fs = require('fs');
const os = require('os');
const path = require('path');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function near(actual, expected, tolerance = 0.05) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pp-${label}-`));
}

function makeLibrary(root) {
  const dir = path.join(root, 'Bhajans');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, Buffer.alloc(32));
  return file;
}

function loads(player) {
  return player.commands.filter((command) => command.type === 'load').length;
}

function sliceTypes(player, from) {
  return player.commands.slice(from).map((command) => command.type);
}

async function main() {
  const root = tempDir('pause');
  const masterRoot = path.join(root, 'master-media');
  const slaveRoot = path.join(root, 'slave-media');
  const masterFile = makeLibrary(masterRoot);
  const slaveFile = makeLibrary(slaveRoot);

  const masterCfg = new ConfigStore(path.join(root, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(root, 'slave.json'));
  masterCfg.setRole('master');
  masterCfg.setDeviceName('Pause Master');
  masterCfg.setMediaRoot(masterRoot);
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Pause Slave');
  slaveCfg.setMediaRoot(slaveRoot);

  const masterPlayer = new RecordingPlayer();
  const slavePlayer = new RecordingPlayer();
  const slave = new SlaveServer({
    player: slavePlayer,
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: false
  });
  const link = new LinkController(masterPlayer, { config: masterCfg });
  link.autoReconnect = false;

  try {
    const listening = await slave.start(0);
    masterCfg.setPaired({
      deviceId: slaveCfg.data.deviceId,
      deviceName: slaveCfg.data.deviceName,
      role: 'slave',
      host: '127.0.0.1',
      port: listening.port
    });
    await link.client.connect({ host: '127.0.0.1', port: listening.port });

    const masterLoaded = await masterPlayer.send('load', { path: masterFile });
    const slaveLoaded = await link.mirrorLoad(masterFile);
    record(
      'master and slave load the same media',
      masterLoaded.ok === true &&
        slaveLoaded.ok === true &&
        slaveLoaded.mediaPath === 'Bhajans/video.mp4' &&
        slavePlayer.state.path === slaveFile &&
        loads(slavePlayer) === 1,
      slaveLoaded.ok ? slaveLoaded.mediaPath : JSON.stringify(slaveLoaded.error)
    );

    masterPlayer.state.duration = 200;
    slavePlayer.state.duration = 200;
    await masterPlayer.send('play');
    const started = await link.mirrorCommand('play', {});
    record(
      'master play starts slave without a second load',
      started.ok === true && slavePlayer.state.status === 'playing' && loads(slavePlayer) === 1,
      slavePlayer.state.status
    );
    record(
      'remote play enters fullscreen',
      slavePlayer.state.fullscreen === true
    );

    masterPlayer.state.position = 10;
    masterPlayer.state.status = 'playing';
    slavePlayer.state.position = 10;
    slavePlayer.state.status = 'playing';
    const sent = [];
    const socketWrite = link.client.socket.write.bind(link.client.socket);
    link.client.socket.write = (chunk, callback) => {
      sent.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      return socketWrite(chunk, callback);
    };
    const beforePause = slavePlayer.commands.length;
    const paused = await link.mirrorCommand('pause', {});
    const pauseMessage = JSON.parse(sent.filter((line) => line.includes('"pause"')).pop());
    const pauseTypes = sliceTypes(slavePlayer, beforePause);
    record(
      'pause at 10s keeps the slave position',
      paused.ok === true &&
        slavePlayer.state.status === 'paused' &&
        near(slavePlayer.state.position, 10) &&
        loads(slavePlayer) === 1 &&
        !pauseTypes.includes('load') &&
        !pauseTypes.includes('fullscreen'),
      `pos=${slavePlayer.state.position} status=${slavePlayer.state.status} cmds=${pauseTypes.join(',')}`
    );
    record(
      'pause leaves fullscreen on',
      slavePlayer.state.fullscreen === true
    );
    record(
      'pause sends media, position, and paused state',
      pauseMessage.type === 'pause' &&
        pauseMessage.payload.position === 10 &&
        pauseMessage.payload.state === 'paused' &&
        pauseMessage.payload.mediaPath === 'Bhajans/video.mp4',
      JSON.stringify(pauseMessage.payload)
    );

    masterPlayer.state.status = 'playing';
    sent.length = 0;
    const beforeResume = slavePlayer.commands.length;
    const resumed = await link.mirrorCommand('play', {});
    const playMessage = JSON.parse(sent.filter((line) => line.includes('"play"')).pop());
    const resumeTypes = sliceTypes(slavePlayer, beforeResume);
    record(
      'play resumes from 10s and does not restart at 0',
      resumed.ok === true &&
        slavePlayer.state.status === 'playing' &&
        near(slavePlayer.state.position, 10) &&
        slavePlayer.state.position > 1 &&
        loads(slavePlayer) === 1 &&
        !resumeTypes.includes('load') &&
        !resumeTypes.includes('seek') &&
        playMessage.payload.state === 'playing' &&
        playMessage.payload.position === 10 &&
        playMessage.payload.mediaPath === 'Bhajans/video.mp4',
      `pos=${slavePlayer.state.position} cmds=${resumeTypes.join(',')} payload=${JSON.stringify(playMessage.payload)}`
    );

    for (const seconds of [1, 30, 120]) {
      slavePlayer.state.position = 0;
      slavePlayer.state.status = 'playing';
      masterPlayer.state.position = seconds;
      masterPlayer.state.status = 'playing';
      const from = slavePlayer.commands.length;
      const result = await link.mirrorCommand('pause', {});
      const types = sliceTypes(slavePlayer, from);
      record(
        `pause at ${seconds}s`,
        result.ok === true &&
          slavePlayer.state.status === 'paused' &&
          near(slavePlayer.state.position, seconds) &&
          loads(slavePlayer) === 1 &&
          !types.includes('load') &&
          types.includes('seek') &&
          types.includes('pause') &&
          types.indexOf('seek') < types.indexOf('pause'),
        `pos=${slavePlayer.state.position} cmds=${types.join(',')}`
      );
    }

    slavePlayer.state.position = 9.96;
    slavePlayer.state.status = 'playing';
    masterPlayer.state.position = 10;
    masterPlayer.state.status = 'playing';
    const beforeDrift = slavePlayer.commands.length;
    const drift = await link.mirrorCommand('pause', {});
    const driftTypes = sliceTypes(slavePlayer, beforeDrift);
    record(
      'pause within 50ms does not seek or reload',
      drift.ok === true &&
        slavePlayer.state.status === 'paused' &&
        slavePlayer.state.position === 9.96 &&
        loads(slavePlayer) === 1 &&
        !driftTypes.includes('load') &&
        !driftTypes.includes('seek') &&
        driftTypes.includes('pause'),
      `pos=${slavePlayer.state.position} cmds=${driftTypes.join(',')}`
    );

    slavePlayer.state.status = 'paused';
    slavePlayer.state.position = 83.45;
    masterPlayer.state.status = 'paused';
    masterPlayer.state.position = 83.45;
    const beforeSeekPaused = slavePlayer.commands.length;
    const seekPaused = await link.mirrorCommand('seek', { seconds: 120, state: 'paused' });
    const seekPausedTypes = sliceTypes(slavePlayer, beforeSeekPaused);
    record(
      'seek while paused stays paused',
      seekPaused.ok === true &&
        slavePlayer.state.status === 'paused' &&
        near(slavePlayer.state.position, 120) &&
        loads(slavePlayer) === 1 &&
        !seekPausedTypes.includes('load') &&
        !seekPausedTypes.includes('play'),
      `pos=${slavePlayer.state.position} status=${slavePlayer.state.status} cmds=${seekPausedTypes.join(',')}`
    );

    slavePlayer.state.status = 'playing';
    slavePlayer.state.position = 120;
    masterPlayer.state.status = 'playing';
    const beforeSeekPlaying = slavePlayer.commands.length;
    const seekPlaying = await link.mirrorCommand('seek', { seconds: 15, state: 'playing' });
    const seekPlayingTypes = sliceTypes(slavePlayer, beforeSeekPlaying);
    record(
      'seek while playing stays playing',
      seekPlaying.ok === true &&
        slavePlayer.state.status === 'playing' &&
        near(slavePlayer.state.position, 15) &&
        loads(slavePlayer) === 1 &&
        !seekPlayingTypes.includes('load') &&
        !seekPlayingTypes.includes('pause'),
      `pos=${slavePlayer.state.position} status=${slavePlayer.state.status} cmds=${seekPlayingTypes.join(',')}`
    );

    slavePlayer.state.position = 30;
    slavePlayer.state.status = 'playing';
    const beforeStop = slavePlayer.commands.length;
    const stopped = await link.mirrorCommand('stop', {});
    const stopTypes = sliceTypes(slavePlayer, beforeStop);
    record(
      'stop resets the slave to 00:00 and does not reload',
      stopped.ok === true &&
        slavePlayer.state.status === 'stopped' &&
        slavePlayer.state.position === 0 &&
        loads(slavePlayer) === 1 &&
        stopTypes.length === 1 &&
        stopTypes[0] === 'stop',
      `pos=${slavePlayer.state.position} status=${slavePlayer.state.status} cmds=${stopTypes.join(',')}`
    );
  } finally {
    link.client.disconnect();
    await slave.stop();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pause/resume checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
