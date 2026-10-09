const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const results = [];
const audioPath = '/tmp/pp-role-tone.wav';

function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
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

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function main() {
  writeWav(audioPath);
  const port = 9229;
  const userData = '/tmp/pp-slave-role';
  fs.mkdirSync(userData, { recursive: true });
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_ROLE: 'slave', PLAYOUT_MUTE: '1' }),
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
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    });
    function send(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }
    async function evaluate(expression) {
      const evaluated = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const remote = evaluated.result && evaluated.result.result ? evaluated.result.result : evaluated.result;
      if (remote && remote.exceptionDetails) {
        return { error: remote.exceptionDetails.text, description: remote.exceptionDetails.exception && remote.exceptionDetails.exception.description };
      }
      return remote ? remote.value : null;
    }
    const readControls = `(() => {
      function hidden(id) {
        const node = document.getElementById(id);
        return !node || node.hidden || !!(node.closest && node.closest('[hidden]'));
      }
      return {
        role: linkSnapshot && linkSnapshot.role,
        openFile: hidden('filePickers'),
        openFileDisabled: !!document.getElementById('chooseFileBtn').disabled,
        media: hidden('chooseMediaBtn'),
        transport: hidden('transport'),
        previous: hidden('prevBtn'),
        next: hidden('nextBtn'),
        playAll: hidden('playAllLabel'),
        seek: hidden('seekControls'),
        speed: hidden('speedCard'),
        playlist: document.getElementById('fileInfo') ? document.getElementById('fileInfo').textContent : '',
        name: document.getElementById('masterFileName').textContent,
        position: document.getElementById('infoPosition').textContent,
        state: document.getElementById('previewState').textContent,
        link: document.getElementById('linkStatusLine').textContent,
        index: currentFileIndex
      };
    })()`;
    let slaveUi = null;
    for (let i = 0; i < 30; i += 1) {
      slaveUi = await evaluate(readControls);
      if (slaveUi && slaveUi.role === 'slave' && slaveUi.openFile) break;
      await sleep(200);
    }
    const denied = await evaluate(`(async () => {
      currentPlaylistFiles = [
        { path: '/tmp/pp-local-a.wav', name: 'local-a.wav', type: 'audio', duration: 1 },
        { path: '/tmp/pp-local-b.wav', name: 'local-b.wav', type: 'audio', duration: 1 }
      ];
      const selected = selectIndex(1);
      const before = currentFileIndex;
      await nextFile();
      const afterNext = currentFileIndex;
      applyAuthoritativeSession({
        playlistKnown: true,
        playlist: [
          { path: '/tmp/pp-from-master-a.wav', name: 'from-master-a.wav', type: 'audio', duration: 1 },
          { path: '/tmp/pp-from-master-b.wav', name: 'from-master-b.wav', type: 'audio', duration: 1 }
        ],
        currentIndex: 0,
        playAll: true,
        state: 'paused',
        position: 1.25,
        player: {
          path: '/tmp/pp-from-master-a.wav',
          status: 'paused',
          position: 1.25,
          duration: 1,
          rate: 1
        }
      });
      // File dialogs stay available on the Slave by design; they would block on a native panel here.
      const loaded = await window.electronAPI.player.load(${JSON.stringify(audioPath)});
      return { selected, before, afterNext, loaded, ui: ${readControls} };
    })()`);
    const slaveBlocked = denied && !denied.error &&
      denied.selected === false && denied.before === 0 && denied.afterNext === 0 &&
      denied.loaded && denied.loaded.ok === false && /Master/.test(denied.loaded.error || '');
    const ui = denied && denied.ui;
    record(
      'slave hides file pickers and playback controls',
      slaveUi && slaveUi.role === 'slave' && ui &&
        ui.openFile && ui.openFileDisabled && ui.media && ui.transport &&
        ui.previous && ui.next && ui.playAll && ui.seek && ui.speed &&
        /Slave/.test(ui.link || ''),
      JSON.stringify(ui || slaveUi)
    );
    record(
      'slave cannot load files or change the playlist locally',
      slaveBlocked && ui && ui.name === 'from-master-a.wav' && ui.playlist.indexOf('from-master-a.wav') >= 0 &&
        ui.state === 'Paused' && ui.position !== '—',
      JSON.stringify(denied && { selected: denied.selected, loaded: denied.loaded, name: ui && ui.name, state: ui && ui.state })
    );
    const master = await evaluate(`(async () => {
      const switched = await window.electronAPI.link.setRole('master');
      for (let i = 0; i < 20; i += 1) {
        if (linkSnapshot && linkSnapshot.role === 'master' && !document.getElementById('filePickers').hidden) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const loaded = await window.electronAPI.player.load(${JSON.stringify(audioPath)});
      const state = await window.electronAPI.player.getState();
      return { switched: switched && switched.snapshot, ui: ${readControls}, loaded, path: state && state.state && state.state.path };
    })()`);
    record(
      'master restores file controls and can load a file',
      master && !master.error && master.ui && master.ui.role === 'master' &&
        master.ui.openFile === false && master.ui.openFileDisabled === false &&
        master.ui.transport === false && master.ui.playAll === false && master.ui.speed === false &&
        master.loaded && master.loaded.ok !== false && master.path === audioPath,
      JSON.stringify(master && { role: master.ui && master.ui.role, open: master.ui && master.ui.openFile, loaded: master.loaded && master.loaded.ok, path: master.path, error: master.error || (master.loaded && master.loaded.error) })
    );
    const again = await evaluate(`(async () => {
      const switched = await window.electronAPI.link.setRole('slave');
      for (let i = 0; i < 20; i += 1) {
        if (linkSnapshot && linkSnapshot.role === 'slave' && document.getElementById('filePickers').hidden) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const loaded = await window.electronAPI.player.load(${JSON.stringify(audioPath)});
      return { ui: ${readControls}, loaded };
    })()`);
    record(
      'switching back to slave blocks file loading again',
      again && !again.error && again.ui && again.ui.role === 'slave' && again.ui.openFile && again.ui.transport &&
        again.loaded && again.loaded.ok === false && /Master/.test(again.loaded.error || ''),
      JSON.stringify(again && { role: again.ui && again.ui.role, loaded: again.loaded })
    );
    ws.close();
  } finally {
    child.kill('SIGTERM');
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} slave role checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
