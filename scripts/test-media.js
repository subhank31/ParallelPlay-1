const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { describeSelection, expandPlaylistSelection, mediaKind, mediaPathError } = require('../player-ipc');
const { resolveMediaPath, findMediaMatch } = require('../link/media-path');
const { execute } = require('../link/player-bridge');
const { RecordingPlayer } = require('../link/recording-player');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function writeWav(filePath) {
  const samples = 4410;
  const data = Buffer.alloc(samples * 2);
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

async function main() {
  const selected = [
    '/media/z-last.mp3',
    '/media/a-first.wav',
    '/media/clip.mp4'
  ];
  const described = describeSelection(selected);
  record(
    'playlist keeps selection order',
    described.map((entry) => entry.name).join(',') === 'z-last.mp3,a-first.wav,clip.mp4',
    described.map((entry) => entry.name).join(',')
  );
  record(
    'playlist marks audio and video',
    described[0].type === 'audio' && described[1].type === 'audio' && described[2].type === 'video' &&
      described.every((entry) => entry.duration === null && entry.path),
    described.map((entry) => entry.type).join(',')
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-media-'));
  const root = path.join(dir, 'library');
  fs.mkdirSync(path.join(root, 'Songs'), { recursive: true });
  const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'm4b', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'caf'];
  for (const ext of audioExts) {
    const file = path.join(root, 'Songs', `tone.${ext}`);
    fs.writeFileSync(file, ext === 'wav' ? '' : 'x');
    if (ext === 'wav') writeWav(file);
    const localError = mediaPathError(file);
    const remote = resolveMediaPath(root, `Songs/tone.${ext}`);
    record(
      `accept ${ext}`,
      localError == null && remote.ok === true && mediaKind(file) === 'audio',
      localError || (remote.error && remote.error.message)
    );
  }
  const mkv = path.join(root, 'Songs', 'nope.mkv');
  fs.writeFileSync(mkv, 'x');
  record('reject mkv', typeof mediaPathError(mkv) === 'string', mediaPathError(mkv));

  const album = path.join(root, 'Album');
  fs.mkdirSync(path.join(album, 'disc2'), { recursive: true });
  fs.writeFileSync(path.join(album, '10-last.mp3'), 'x');
  fs.writeFileSync(path.join(album, '2-second.wav'), 'x');
  fs.writeFileSync(path.join(album, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(album, 'skip.mkv'), 'x');
  fs.writeFileSync(path.join(album, 'disc2', '1-first.m4a'), 'x');
  const fromFolder = expandPlaylistSelection([album]);
  record(
    'folder loads audio in numeric order and skips other files',
    fromFolder.map((file) => path.basename(file)).join(',') === '2-second.wav,10-last.mp3,1-first.m4a',
    fromFolder.map((file) => path.basename(file)).join(',')
  );
  const picked = expandPlaylistSelection([
    path.join(album, '10-last.mp3'),
    path.join(album, '2-second.wav')
  ]);
  record(
    'picked audio files stay in selection order',
    picked.map((file) => path.basename(file)).join(',') === '10-last.mp3,2-second.wav',
    picked.map((file) => path.basename(file)).join(',')
  );
  const notesOnly = path.join(root, 'Notes');
  fs.mkdirSync(notesOnly);
  fs.writeFileSync(path.join(notesOnly, 'readme.txt'), 'x');
  let emptyMessage = '';
  try {
    expandPlaylistSelection([notesOnly]);
  } catch (error) {
    emptyMessage = error.message;
  }
  record(
    'folder without media explains the failure',
    emptyMessage === 'That folder has no supported audio or video files.',
    emptyMessage
  );

  const slaveFile = path.join(root, 'Songs', 'tone.mp3');
  const player = new RecordingPlayer();
  await player.send('load', { path: slaveFile });
  player.state.position = 42;
  player.state.status = 'playing';
  const loadsBefore = player.commands.filter((command) => command.type === 'load').length;
  const paused = await execute(player, {
    type: 'pause',
    source: 'master',
    payload: { position: 42, mediaPath: 'Songs/tone.mp3', state: 'paused' }
  }, { mediaRoot: root });
  const loadsAfter = player.commands.filter((command) => command.type === 'load').length;
  record(
    'audio pause keeps position and does not reload',
    paused.ok === true && player.state.status === 'paused' && player.state.position === 42 && loadsAfter === loadsBefore,
    `pos=${player.state.position} status=${player.state.status}`
  );
  player.state.status = 'paused';
  const resumed = await execute(player, {
    type: 'play',
    source: 'master',
    payload: { position: 42, mediaPath: 'Songs/tone.mp3', state: 'playing' }
  }, { mediaRoot: root });
  record(
    'audio play resumes at the paused position',
    resumed.ok === true && player.state.status === 'playing' && player.state.position === 42 &&
      player.commands.filter((command) => command.type === 'load').length === loadsBefore &&
      player.commands.every((command) => command.type !== 'fullscreen'),
    `pos=${player.state.position}`
  );

  const { resolveHelperPath } = require('../player-session');
  const binary = resolveHelperPath();
  const wav = path.join(root, 'Songs', 'tone.wav');
  if (!fs.existsSync(binary)) {
    record('AVPlayer audio load', false, 'PlayoutEngine is not built');
  } else {
    const played = await playWav(binary, wav);
    record(
      'AVPlayer loads and pauses a wav without video',
      played.ok === true && played.status === 'paused' && played.position < 1 && played.duration > 0.05,
      played.detail
    );
  }

  const flat = path.join(root, 'flat.mp3');
  fs.writeFileSync(flat, 'same-content');
  const nested = path.join(root, 'nested', 'flat.mp3');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, 'same-content');
  const dup = findMediaMatch(root, { name: 'flat.mp3', sizeBytes: fs.statSync(flat).size });
  record(
    'duplicate filename and size is rejected',
    dup.ok === false && dup.error && dup.error.code === 'DUPLICATE_MEDIA',
    dup.error && dup.error.message
  );
  fs.writeFileSync(path.join(root, 'only-name.mp3'), 'unique-bytes');
  const byName = findMediaMatch(root, { name: 'only-name.mp3', sizeBytes: fs.statSync(path.join(root, 'only-name.mp3')).size });
  record(
    'filename and size fallback resolves a unique file',
    byName.ok === true && byName.absolutePath.endsWith('only-name.mp3'),
    byName.error && byName.error.message
  );

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} media checks passed`);
  return failed.length === 0 ? 0 : 1;
}

function playWav(binary, wav) {
  return new Promise((resolve) => {
    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1' })
    });
    const pending = new Map();
    let nextId = 1;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch (error) { return; }
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    function send(type, fields) {
      const id = String(nextId++);
      return new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout ' + type)), 15000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          done(message);
        });
        child.stdin.write(JSON.stringify(Object.assign({ id, type }, fields)) + '\n');
      });
    }
    (async () => {
      try {
        const loaded = await send('load', { path: wav });
        const started = await send('play', {});
        await new Promise((r) => setTimeout(r, 200));
        const paused = await send('pause', {});
        const full = await send('fullscreen', { enabled: true });
        const state = paused.state || {};
        const fullState = full.state || {};
        resolve({
          ok: loaded.ok === true && started.ok === true && paused.ok === true && fullState.fullscreen !== true,
          status: state.status,
          position: state.position,
          duration: state.duration,
          detail: `${state.status} pos=${state.position} dur=${state.duration} fullscreen=${fullState.fullscreen} err=${loaded.error || paused.error || full.error || ''}`
        });
      } catch (error) {
        resolve({ ok: false, detail: error.message });
      } finally {
        child.kill('SIGTERM');
      }
    })();
  });
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
