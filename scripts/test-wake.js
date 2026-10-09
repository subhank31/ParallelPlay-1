const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const PlaylistUI = require('../playlist-ui');
const { masterSessionPayload, resolveSessionFile } = require('../link/session-state');
const { SlaveServer } = require('../link/slave-server');
const { MasterClient } = require('../link/master-client');
const { RecordingPlayer } = require('../link/recording-player');
const { PlayerSession } = require('../player-session');

const results = [];
const videoPath = process.env.PLAYOUT_MEDIA || '';

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeWav(filePath) {
  const data = Buffer.alloc(44100 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function logic() {
  const playing = {
    status: 'playing',
    path: '/tmp/pp-wake-media/Song.wav',
    position: 3.25,
    duration: 12.5,
    rate: 1
  };
  const view = PlaylistUI.describeRecovery(playing);
  record(
    'a playing player reports file, position, duration, and rate',
    view.ok === true && view.name === 'Song.wav' && view.position === 3.25 &&
      view.duration === 12.5 && view.rate === 1 && view.status === 'playing',
    JSON.stringify(view)
  );
  const empty = PlaylistUI.describeRecovery({ status: 'playing', path: null, position: null, duration: null, rate: null });
  record(
    'playing with no file is not shown as ready',
    empty.ok === false && empty.fatal === true && /file/i.test(empty.reason),
    empty.reason
  );
  const missingTime = PlaylistUI.describeRecovery({ status: 'playing', path: '/media/Song.wav', position: null, duration: null, rate: 1 });
  record(
    'playing without a position and duration is rejected',
    missingTime.ok === false && /position/i.test(missingTime.reason),
    missingTime.reason
  );
  const playlist = [
    { path: '/media/One.wav', name: 'One.wav' },
    { path: '/media/Song.wav', name: 'Song.wav' }
  ];
  record(
    'the playlist index follows the player file',
    PlaylistUI.playlistIndex(playlist, '/media/Song.wav') === 1 &&
      PlaylistUI.playlistIndex(playlist, '/media/Missing.wav') === -1,
    ''
  );
  const rewind = PlaylistUI.reconcileCommands(
    { path: '/media/Song.wav', position: 4, status: 'paused', rate: 1 },
    { path: '/media/Song.wav', state: 'paused', position: 0, duration: 12.5, rate: 1 }
  );
  record(
    'the same file seeks back when the master is at zero',
    rewind.ok === true && rewind.commands.some((command) => command.type === 'seek' && command.seconds === 0),
    JSON.stringify(rewind.commands)
  );
  const fresh = PlaylistUI.reconcileCommands(
    { path: '/media/One.wav', position: 4, status: 'paused', rate: 1 },
    { path: '/media/Song.wav', state: 'paused', position: 0, duration: 12.5, rate: 1 }
  );
  record(
    'a different file does not seek when the master is at zero',
    fresh.ok === true && !fresh.commands.some((command) => command.type === 'seek'),
    JSON.stringify(fresh.commands)
  );
  const same = PlaylistUI.reconcileCommands(
    { path: '/media/Song.wav', position: 3.25, status: 'playing', rate: 1 },
    { path: '/media/Song.wav', state: 'playing', position: 3.26, duration: 12.5, rate: 1 }
  );
  record(
    'an already matching player is left alone',
    same.ok === true && same.commands.length === 0,
    JSON.stringify(same.commands)
  );
  const moved = PlaylistUI.reconcileCommands(
    { path: '/media/One.wav', position: 0, status: 'paused', rate: 1 },
    { path: '/media/Song.wav', state: 'playing', position: 3.25, duration: 12.5, rate: 1.5 }
  );
  record(
    'a different file is loaded, seeked, rated, and played',
    moved.ok === true &&
      JSON.stringify(moved.commands.map((command) => command.type)) === JSON.stringify(['load', 'seek', 'setRate', 'play']) &&
      moved.commands[1].seconds === 3.25 && moved.commands[2].rate === 1.5,
    JSON.stringify(moved.commands)
  );
  const paused = PlaylistUI.reconcileCommands(
    { path: '/media/Song.wav', position: 0, status: 'playing', rate: 1 },
    { path: '/media/Song.wav', state: 'paused', position: 4, duration: 12.5, rate: 1 }
  );
  record(
    'pause and seek are requested without restarting at zero',
    paused.ok === true &&
      JSON.stringify(paused.commands.map((command) => command.type)) === JSON.stringify(['seek', 'pause']) &&
      !paused.commands.some((command) => command.type === 'load' || command.type === 'stop'),
    JSON.stringify(paused.commands)
  );

  fs.mkdirSync('/tmp/pp-wake-media', { recursive: true });
  fs.writeFileSync('/tmp/pp-wake-media/Song.wav', '');
  const session = masterSessionPayload(playing, {
    playlist: [{ path: '/tmp/pp-wake-media/Song.wav', name: 'Song.wav', type: 'audio', duration: 12.5 }],
    currentIndex: 0,
    playAll: true
  }, '/tmp/pp-wake-media');
  record(
    'the master session keeps the player values and play all',
    session.ok === true && session.payload.state === 'playing' && session.payload.position === 3.25 &&
      session.payload.duration === 12.5 && session.payload.rate === 1 && session.payload.playAll === true &&
      session.payload.currentIndex === 0 && session.payload.item.mediaPath === 'Song.wav' &&
      session.payload.item.name === 'Song.wav',
    JSON.stringify(session.payload && session.payload.item)
  );
  const resolved = resolveSessionFile(session.payload.item, '/tmp/pp-wake-media', () => false);
  record(
    'the slave resolves the master file on its own disk',
    resolved.ok === true && resolved.path === '/tmp/pp-wake-media/Song.wav',
    resolved.path || resolved.reason
  );
  const unavailable = masterSessionPayload({ status: 'playing', path: null }, { playlist: [], playAll: false }, '');
  record(
    'the master does not invent a session for an empty player',
    unavailable.ok === false && unavailable.error.code === 'STATE_UNAVAILABLE',
    unavailable.error && unavailable.error.message
  );
}

async function linkRoundTrip() {
  const slavePlayer = new RecordingPlayer();
  const slave = new SlaveServer({ player: slavePlayer, host: '127.0.0.1' });
  const master = new MasterClient();
  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });
  master.on('request', (message) => {
    const built = masterSessionPayload({
      status: 'playing',
      path: '/tmp/pp-wake-media/Song.wav',
      position: 6,
      duration: 12.5,
      rate: 1
    }, {
      playlist: [{ path: '/tmp/pp-wake-media/Song.wav', name: 'Song.wav', type: 'audio', duration: null }],
      playAll: true
    }, '/tmp/pp-wake-media');
    const intruder = net.connect(listening.port, '127.0.0.1', () => {
      intruder.write(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        ok: true,
        payload: { state: 'stopped', position: 0 }
      }) + '\n');
      setTimeout(() => {
        master.socket.write(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          ok: built.ok,
          payload: built.payload
        }) + '\n');
        intruder.end();
      }, 40);
    });
    intruder.on('error', () => {});
  });
  const response = await slave.request('getSession');
  record(
    'the slave request returns the master session',
    response.ok === true && response.payload.state === 'playing' && response.payload.position === 6 &&
      response.payload.playAll === true && response.payload.item.mediaPath === 'Song.wav' &&
      response.payload.currentIndex === 0 && response.payload.playlist[0].duration === null,
    JSON.stringify(response.payload && { state: response.payload.state, index: response.payload.currentIndex })
  );
  master.disconnect();
  await slave.stop();
}

function get(url) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function playAndRecover(session, filePath, kind) {
  const loaded = await session.send('load', { path: filePath }, 30000);
  const started = await session.send('play');
  await sleep(400);
  const before = await session.send('getState');
  const recovered = await session.send('recover', {}, 8000);
  const after = recovered && recovered.state ? recovered.state : null;
  const playing = before && before.state && before.state.status === 'playing';
  record(
    `${kind} wake recovery keeps the file, position, duration, and rate`,
    loaded.ok !== false && started.ok !== false && playing && after &&
      after.path === filePath && after.status === 'playing' &&
      Number.isFinite(after.position) && after.position >= 0 &&
      Number.isFinite(after.duration) && after.duration > 0 &&
      Number.isFinite(after.rate) && after.rate > 0,
    JSON.stringify({ before: before && before.state, after })
  );
  return after;
}

async function helper() {
  process.env.PLAYOUT_MUTE = '1';
  const audioPath = '/tmp/pp-wake-tone.wav';
  writeWav(audioPath);
  const session = new PlayerSession();
  session.start();
  try {
    await playAndRecover(session, audioPath, 'audio');
    if (videoPath && fs.existsSync(videoPath)) {
      await session.send('pause').catch(() => null);
      await playAndRecover(session, videoPath, 'video');
    }
  } finally {
    await session.shutdown();
  }
}

async function ui() {
  const audioPath = '/tmp/pp-wake-tone.wav';
  writeWav(audioPath);
  const port = 9228;
  const userData = '/tmp/pp-wake-ui';
  fs.mkdirSync(userData, { recursive: true });
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_ROLE: 'master', PLAYOUT_MUTE: '1' }),
    stdio: 'ignore'
  });
  try {
    let targets = '';
    for (let i = 0; i < 40; i += 1) {
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
    let next = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      pending.get(message.id)(message.result);
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
      const evaluated = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const remote = evaluated.result && evaluated.result.result ? evaluated.result.result : evaluated.result;
      if (remote && remote.exceptionDetails) return { error: remote.exceptionDetails.text, description: remote.exceptionDetails.exception && remote.exceptionDetails.exception.description };
      return remote ? remote.value : null;
    }
    const playVideo = Boolean(videoPath) && fs.existsSync(videoPath);
    const audio = await evaluate(`(async () => {
      linkSnapshot = { role: 'master', paired: false };
      currentPlaylistFiles = [
        { path: ${JSON.stringify(audioPath)}, name: 'tone.wav', type: 'audio', duration: 1 }${playVideo ? `,
        { path: ${JSON.stringify(videoPath)}, name: 'Sub 1.mp4', type: 'video', duration: 20 }` : ''}
      ];
      document.getElementById('playAllBox').checked = true;
      selectIndex(0);
      await cuePlaylistIndex(0);
      await playFile();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const recovered = await window.electronAPI.player.recover();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const state = await window.electronAPI.player.getState();
      return {
        recovered: recovered && recovered.state,
        state: state && state.state,
        name: document.getElementById('masterFileName').textContent,
        preview: document.getElementById('previewFile').textContent,
        headline: document.getElementById('currentItemHeadline').textContent,
        previewState: document.getElementById('previewState').textContent,
        position: document.getElementById('infoPosition').textContent,
        duration: document.getElementById('infoDuration').textContent,
        rate: document.getElementById('infoRate').textContent,
        index: document.getElementById('currentPosition').textContent,
        playAll: document.getElementById('playAllBox').checked
      };
    })()`);
    const audioState = audio && (audio.state || audio.recovered);
    record(
      'audio wake rebuilds the UI from the player',
      audio && !audio.error && audioState && audioState.status === 'playing' &&
        audioState.path === audioPath && Number.isFinite(audioState.position) &&
        Number.isFinite(audioState.duration) && audioState.duration > 0 &&
        audio.name === 'tone.wav' && audio.preview === 'tone.wav' &&
        audio.headline === 'Now playing' && audio.previewState === 'Playing' &&
        audio.position !== '—' && audio.duration !== '—' && audio.index === '1' && audio.playAll === true,
      JSON.stringify(audio)
    );
    if (playVideo) {
    const video = await evaluate(`(async () => {
      selectIndex(1);
      await cuePlaylistIndex(1);
      await playFile();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await window.electronAPI.player.recover();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const state = await window.electronAPI.player.getState();
      return {
        state: state && state.state,
        name: document.getElementById('masterFileName').textContent,
        headline: document.getElementById('currentItemHeadline').textContent,
        previewState: document.getElementById('previewState').textContent,
        position: document.getElementById('infoPosition').textContent,
        duration: document.getElementById('infoDuration').textContent,
        index: document.getElementById('currentPosition').textContent
      };
    })()`);
    const videoState = video && video.state;
    record(
      'video wake rebuilds the UI from the player',
      video && !video.error && videoState && videoState.status === 'playing' &&
        videoState.path === videoPath && Number.isFinite(videoState.duration) && videoState.duration > 1 &&
        video.name === 'Sub 1.mp4' && video.headline === 'Now playing' && video.previewState === 'Playing' &&
        video.position !== '—' && video.duration !== '—' && video.index === '2',
      JSON.stringify(video)
    );
    }
    const broken = await evaluate(`(async () => {
      await recoverPlayback({ status: 'playing', path: null, position: null, duration: null, rate: null });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = await window.electronAPI.player.getState();
      return {
        headline: document.getElementById('currentItemHeadline').textContent,
        previewState: document.getElementById('previewState').textContent,
        response: document.getElementById('responseBox').textContent,
        status: state && state.state && state.state.status
      };
    })()`);
    record(
      'an unreadable player is stopped and shown as an error',
      broken && broken.headline === 'Playback error' && broken.previewState === 'Error' &&
        /could not be restored/i.test(broken.response || '') &&
        broken.status !== 'playing',
      JSON.stringify(broken)
    );
    ws.close();
  } finally {
    child.kill('SIGTERM');
  }
}

async function main() {
  logic();
  await linkRoundTrip();
  await helper();
  await ui();
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} wake recovery checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
