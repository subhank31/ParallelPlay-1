const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const PlaylistUI = require('../playlist-ui');
const { execute } = require('../link/player-bridge');
const { RecordingPlayer } = require('../link/recording-player');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function logic() {
  const first = PlaylistUI.navigationState(0, 3);
  record(
    'previous stays visible and is disabled only on the first item',
    first.previousHidden === false && first.previousDisabled === true && first.nextDisabled === false,
    JSON.stringify(first)
  );
  const middle = PlaylistUI.navigationState(1, 3);
  record(
    'previous and next are usable between items',
    middle.previousHidden === false && middle.nextHidden === false &&
      middle.previousDisabled === false && middle.nextDisabled === false,
    JSON.stringify(middle)
  );
  const only = PlaylistUI.navigationState(0, 1);
  record(
    'a single file keeps both buttons visible and disabled',
    only.previousHidden === false && only.nextHidden === false && only.previousDisabled && only.nextDisabled,
    JSON.stringify(only)
  );
  record(
    'end of an item selects the next index and does not wrap',
    PlaylistUI.nextIndexAfterEnd(0, 3, '/media/a.mp3', '/media/a.mp3') === 1 &&
      PlaylistUI.nextIndexAfterEnd(2, 3, '/media/c.mp3', '/media/c.mp3') === null,
    ''
  );
  record(
    'a stale end event does not skip ahead',
    PlaylistUI.nextIndexAfterEnd(1, 3, '/media/a.mp3', '/media/b.mp3') === null,
    ''
  );
  const playing = PlaylistUI.selectionLabel({ hasItem: true, status: 'playing', position: 4 });
  const cued = PlaylistUI.selectionLabel({ hasItem: true, status: 'paused', position: 0 });
  const held = PlaylistUI.selectionLabel({ hasItem: true, status: 'paused', position: 12 });
  const down = PlaylistUI.listScrollTop(0, 100, 240, 40);
  const up = PlaylistUI.listScrollTop(200, 100, 20, 40);
  const visible = PlaylistUI.listScrollTop(40, 100, 60, 30);
  record(
    'the playlist list scrolls only far enough to show the selected row',
    down === 180 && up === 20 && visible === 40 &&
      down + 100 >= 240 + 40 && up <= 20,
    JSON.stringify({ down, up, visible })
  );
  record(
    'play all continues and a finished playlist stays on the last item',
    PlaylistUI.afterEndAction(true, true) === 'play-next' &&
      PlaylistUI.afterEndAction(false, true) === 'select-next' &&
      PlaylistUI.afterEndAction(true, false) === 'stay' &&
      PlaylistUI.afterEndAction(false, false) === 'stay',
    ''
  );
  record(
    'a playing item is labeled Playing and a cued item is Selected',
    playing.mode === 'playing' && playing.headline === 'Now playing' &&
      cued.mode === 'ready' && cued.headline === 'Selected' && cued.state === 'Ready' &&
      held.mode === 'paused' && held.state === 'Paused',
    JSON.stringify({ playing, cued, held })
  );
  record(
    'fullscreen is available for video only',
    PlaylistUI.fullscreenAvailable('video') === true &&
      PlaylistUI.fullscreenAvailable('/songs/a.mp3') === false &&
      PlaylistUI.fullscreenAvailable('/clips/a.mp4') === true,
    ''
  );

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pp-nav-'));
  fs.mkdirSync(path.join(dir, 'Songs'));
  fs.mkdirSync(path.join(dir, 'Bhajans'));
  const audioFile = path.join(dir, 'Songs', 'tone.mp3');
  const videoFile = path.join(dir, 'Bhajans', 'video.mp4');
  fs.writeFileSync(audioFile, 'x');
  fs.writeFileSync(videoFile, 'x');

  const audio = new RecordingPlayer();
  await audio.send('load', { path: audioFile });
  const played = await execute(audio, {
    type: 'play',
    source: 'master',
    payload: { position: 0, mediaPath: 'Songs/tone.mp3', state: 'playing' }
  }, { mediaRoot: dir });
  record(
    'slave audio play does not enter fullscreen',
    played.ok === true && audio.commands.every((command) => command.type !== 'fullscreen'),
    audio.commands.map((command) => command.type).join(',')
  );

  const video = new RecordingPlayer();
  await video.send('load', { path: videoFile });
  const videoPlayed = await execute(video, {
    type: 'play',
    source: 'master',
    payload: { position: 0, mediaPath: 'Bhajans/video.mp4', state: 'playing' }
  }, { mediaRoot: dir });
  const videoTypes = video.commands.map((command) => command.type);
  record(
    'slave video enters fullscreen before play',
    videoPlayed.ok === true &&
      videoTypes.indexOf('fullscreen') >= 0 &&
      videoTypes.indexOf('fullscreen') < videoTypes.lastIndexOf('play') &&
      video.commands.some((command) => command.type === 'fullscreen' && command.fields.enabled === true),
    videoTypes.join(',')
  );

  const beforeSecond = video.commands.length;
  const again = await execute(video, {
    type: 'play',
    source: 'master',
    payload: { position: 0, mediaPath: 'Bhajans/video.mp4', state: 'playing' }
  }, { mediaRoot: dir });
  const secondTypes = video.commands.slice(beforeSecond).map((command) => command.type);
  record(
    'slave video play does nothing when fullscreen is already on',
    again.ok === true && video.state.status === 'playing' && !secondTypes.includes('fullscreen'),
    secondTypes.join(',')
  );
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function writeWav(filePath, seconds) {
  const samples = Math.round(44100 * (seconds || 0.1));
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

async function ui() {
  writeWav('/tmp/pp-play-order.wav');
  const port = 9227;
  const userData = '/tmp/pp-playlist-ui';
  fs.mkdirSync(userData, { recursive: true });
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLAYOUT_ROLE: 'master' }),
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
    const evaluated = await send('Runtime.evaluate', {
      expression: `(() => {
        const previous = document.getElementById('prevBtn');
        const nextButton = document.getElementById('nextBtn');
        const fullscreen = document.getElementById('fullscreenBtn');
        const style = getComputedStyle(previous);
        return {
          previousHidden: previous.hidden,
          nextHidden: nextButton.hidden,
          previousDisplay: style.display,
          fullscreenHidden: fullscreen.hidden,
          rules: PlaylistUI.navigationState(1, 4)
        };
      })()`,
      returnByValue: true
    });
    const value = evaluated.result && evaluated.result.result ? evaluated.result.result.value : evaluated.result.value;
    record(
      'playlist buttons are on screen',
      value && value.previousHidden === false && value.nextHidden === false && value.previousDisplay !== 'none' &&
        value.fullscreenHidden === true && value.rules.previousDisabled === false,
      JSON.stringify(value)
    );

    async function playOrder(expression) {
      const evaluatedPlay = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      const remote = evaluatedPlay.result && evaluatedPlay.result.result
        ? evaluatedPlay.result.result
        : evaluatedPlay.result;
      if (remote && remote.exceptionDetails) return { error: remote.exceptionDetails.text };
      return remote ? remote.value : null;
    }

    const playback = await playOrder(`(async () => {
      linkSnapshot = { role: 'master', paired: false };
      const entered = [];
      window.electronAPI.player.onEvent((event) => {
        if (event && event.event === 'fullscreen' && event.state && event.state.fullscreen === true) {
          entered.push(event.state.status);
        }
      });
      const audioPath = ${JSON.stringify('/tmp/pp-play-order.wav')};
      const videoPath = ${JSON.stringify('/Users/subhank/Desktop/Finals/Sub 1.mp4')};
      const audioLoaded = await window.electronAPI.player.load(audioPath);
      currentPlaylistFiles = [{ path: audioPath, name: 'tone.wav', type: 'audio', duration: 1 }];
      currentFileIndex = 0;
      entered.length = 0;
      await playFile();
      const audioState = await window.electronAPI.player.getState();
      const audioEntered = entered.slice();
      await window.electronAPI.player.pause();

      const videoLoaded = await window.electronAPI.player.load(videoPath);
      currentPlaylistFiles = [{ path: videoPath, name: 'Sub 1.mp4', type: 'video', duration: 20 }];
      currentFileIndex = 0;
      await window.electronAPI.player.fullscreen(false);
      entered.length = 0;
      await playFile();
      const videoState = await window.electronAPI.player.getState();
      const duringVideo = entered.slice();

      await window.electronAPI.player.pause();
      entered.length = 0;
      await playFile();
      const secondState = await window.electronAPI.player.getState();
      await window.electronAPI.player.pause();
      await window.electronAPI.player.fullscreen(false);
      return {
        audioLoaded: !!(audioLoaded && audioLoaded.ok),
        audioStatus: audioState && audioState.state && audioState.state.status,
        audioFullscreen: audioState && audioState.state && audioState.state.fullscreen,
        audioEntered,
        videoLoaded: !!(videoLoaded && videoLoaded.ok),
        videoEnteredWhile: duringVideo,
        videoStatus: videoState && videoState.state && videoState.state.status,
        videoFullscreen: videoState && videoState.state && videoState.state.fullscreen,
        secondEntered: entered.slice(),
        secondStatus: secondState && secondState.state && secondState.state.status,
        secondFullscreen: secondState && secondState.state && secondState.state.fullscreen,
        response: document.getElementById('responseBox').textContent
      };
    })()`);
    record(
      'audio play does not enter fullscreen',
      playback && playback.audioLoaded === true && playback.audioStatus === 'playing' &&
        playback.audioFullscreen !== true && Array.isArray(playback.audioEntered) && playback.audioEntered.length === 0,
      JSON.stringify(playback)
    );
    record(
      'video play enters fullscreen before playback starts',
      playback && playback.videoLoaded === true &&
        playback.videoFullscreen === true && playback.videoStatus === 'playing' &&
        playback.videoEnteredWhile.length > 0 &&
        playback.videoEnteredWhile.every((status) => status !== 'playing'),
      JSON.stringify(playback && playback.videoEnteredWhile)
    );
    record(
      'video play does nothing when fullscreen is already on',
      playback && playback.secondFullscreen === true && playback.secondStatus === 'playing' &&
        Array.isArray(playback.secondEntered) && playback.secondEntered.length === 0,
      JSON.stringify(playback && playback.secondEntered)
    );
    writeWav('/tmp/pp-item-a.wav');
    writeWav('/tmp/pp-item-b.wav');
    const items = await playOrder(`(async () => {
      function readUi() {
        const rows = [...document.querySelectorAll('.playlist-files li')];
        const index = rows.findIndex((row) => row.classList.contains('current'));
        const state = window.__lastState || null;
        return {
          index,
          count: rows.length,
          name: document.getElementById('masterFileName').textContent,
          preview: document.getElementById('previewFile').textContent,
          info: document.getElementById('infoFile').textContent,
          headline: document.getElementById('currentItemHeadline').textContent,
          previewState: document.getElementById('previewState').textContent,
          rowClass: index >= 0 ? rows[index].className : '',
          rowText: index >= 0 ? rows[index].textContent : '',
          windowVisible: !!(state && state.windowVisible),
          windowX: state && state.windowX,
          windowY: state && state.windowY,
          windowWidth: state && state.windowWidth,
          windowHeight: state && state.windowHeight
        };
      }
      async function remember() {
        const result = await window.electronAPI.player.getState();
        window.__lastState = result && result.state;
        return readUi();
      }
      linkSnapshot = { role: 'master', paired: false };
      currentPlaylistFiles = [
        { path: '/tmp/pp-item-a.wav', name: 'a.wav', type: 'audio', duration: 0.1 },
        { path: '/tmp/pp-item-b.wav', name: 'b.wav', type: 'audio', duration: 0.1 },
        { path: ${JSON.stringify('/Users/subhank/Desktop/Finals/Sub 1.mp4')}, name: 'Sub 1.mp4', type: 'video', duration: 20 }
      ];
      selectIndex(0);
      const first = readUi();
      selectIndex(1);
      const jumped = readUi();
      selectIndex(0);
      await cuePlaylistIndex(0);
      const loaded = await remember();
      await nextFile();
      const next = await remember();
      await previousFile();
      const previous = await remember();
      await playFile();
      let advanced = previous;
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        advanced = await remember();
        const playerPath = window.__lastState && window.__lastState.path;
        if (advanced.index === 1 && advanced.headline === 'Selected' && playerPath && playerPath.endsWith('pp-item-b.wav') && window.__lastState.status !== 'loading') break;
      }
      await nextFile();
      const video = await remember();
      await previousFile();
      const backToAudio = await remember();
      await nextFile();
      const videoAgain = await remember();
      await window.electronAPI.player.pause();
      await window.electronAPI.player.fullscreen(false);
      return { first, jumped, loaded, next, previous, advanced, video, backToAudio, videoAgain };
    })()`);
    const sameItem = (row) => row && row.name && row.name === row.preview && row.preview === row.info;
    record(
      'highlight moves as soon as the selection changes',
      items && items.first.index === 0 && items.first.headline === 'Selected' &&
        items.jumped.index === 1 && items.jumped.name === 'b.wav' && sameItem(items.jumped) &&
        items.jumped.headline === 'Selected' && items.jumped.previewState === 'Ready' &&
        items.jumped.rowClass.indexOf('ready') >= 0 && items.jumped.rowText.indexOf('Selected') < 0,
      JSON.stringify(items && items.jumped)
    );
    record(
      'next and previous keep the highlight and the current item together',
      items && items.next.index === 1 && items.next.name === 'b.wav' && sameItem(items.next) &&
        items.next.headline === 'Selected' &&
        items.previous.index === 0 && items.previous.name === 'a.wav' && sameItem(items.previous),
      JSON.stringify(items && { next: items.next, previous: items.previous })
    );
    record(
      'the next item is selected when a file finishes',
      items && items.advanced.index === 1 && items.advanced.name === 'b.wav' && sameItem(items.advanced) &&
        items.advanced.headline === 'Selected' && items.advanced.previewState !== 'Playing',
      JSON.stringify(items && items.advanced)
    );
    record(
      'audio stays hidden and video keeps the same window',
      items && items.backToAudio.windowVisible === false &&
        items.video.windowVisible === true && items.video.name === 'Sub 1.mp4' && sameItem(items.video) &&
        items.videoAgain.windowVisible === true &&
        items.videoAgain.windowX === items.video.windowX &&
        items.videoAgain.windowY === items.video.windowY &&
        items.videoAgain.windowWidth === items.video.windowWidth &&
        items.videoAgain.windowHeight === items.video.windowHeight,
      JSON.stringify(items && { video: items.video, audio: items.backToAudio, again: items.videoAgain })
    );
    for (let n = 1; n <= 5; n += 1) writeWav('/tmp/pp-playall-' + n + '.wav', 0.55);
    const run = await playOrder(`(async () => {
      const listFiles = [1, 2, 3, 4, 5].map((n) => ({
        path: '/tmp/pp-playall-' + n + '.wav',
        name: 'track-' + n + '.wav',
        type: 'audio',
        duration: 0.1
      }));
      linkSnapshot = { role: 'master', paired: false };
      document.getElementById('playAllBox').checked = false;
      currentPlaylistFiles = listFiles;
      const style = document.createElement('style');
      style.textContent = '.playlist-files { max-height: 72px !important; scroll-behavior: auto !important; }';
      document.head.appendChild(style);
      selectIndex(0);
      const page = document.querySelector('.pages');
      const pageStart = page.scrollTop;
      const steps = [];
      async function place() {
        const result = await window.electronAPI.player.getState();
        window.__lastState = result && result.state;
        const list = document.querySelector('.playlist-files');
        const row = list.querySelector('li.current');
        const listRect = list.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const scroller = document.scrollingElement;
        return {
          index: Number(row.getAttribute('data-index')),
          inside: rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1,
          listTop: list.scrollTop,
          page: page.scrollTop,
          documentTop: scroller ? scroller.scrollTop : 0,
          name: document.getElementById('masterFileName').textContent,
          preview: document.getElementById('previewFile').textContent,
          state: document.getElementById('previewState').textContent,
          rowClass: row.className,
          playerStatus: window.__lastState && window.__lastState.status,
          playerPath: window.__lastState && window.__lastState.path
        };
      }
      await cuePlaylistIndex(0);
      for (let i = 0; i < 4; i += 1) {
        await nextFile();
        await new Promise((resolve) => setTimeout(resolve, 350));
        steps.push(await place());
      }
      await previousFile();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const back = await place();
      document.getElementById('playAllBox').checked = false;
      selectIndex(0);
      await cuePlaylistIndex(0);
      await playFile();
      let single = await place();
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        single = await place();
        if (single.index === 1 && single.state !== 'Playing') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      const singleLater = await place();
      document.getElementById('playAllBox').checked = true;
      selectIndex(0);
      await cuePlaylistIndex(0);
      const seen = [];
      await playFile();
      let finalRow = await place();
      for (let i = 0; i < 160; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        finalRow = await place();
        const key = finalRow.index + ':' + finalRow.state;
        if (seen[seen.length - 1] !== key) seen.push(key);
        if (finalRow.index === 4 && finalRow.state !== 'Playing' && String(finalRow.playerPath || '').endsWith('pp-playall-5.wav') && finalRow.playerStatus !== 'loading' && finalRow.playerStatus !== 'playing') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const stayed = await place();
      return { pageStart, steps, back, single, singleLater, seen, stayed };
    })()`);
    const indexes = run && run.steps.map((step) => step.index);
    record(
      'next keeps each selected row inside the playlist list',
      run && JSON.stringify(indexes) === JSON.stringify([1, 2, 3, 4]) &&
        run.steps.every((step) => step.inside && step.page === run.pageStart && step.documentTop === 0 && step.name === step.preview) &&
        run.steps[3].listTop > run.steps[0].listTop &&
        run.back.index === 3 && run.back.inside && run.back.listTop < run.steps[3].listTop && run.back.page === run.pageStart,
      JSON.stringify(run && { indexes, back: run.back && run.back.index, pages: run.steps && run.steps.map((step) => step.page) })
    );
    record(
      'without play all, the next item stays selected and does not start',
      run && run.single.index === 1 && run.single.state !== 'Playing' &&
        run.singleLater.index === 1 && run.singleLater.state !== 'Playing',
      JSON.stringify(run && { single: run.single, later: run.singleLater })
    );
    const played = run && run.seen.filter((key) => key.endsWith(':Playing')).map((key) => Number(key.split(':')[0]));
    record(
      'play all continues through five files and stops on the last',
      run && played.indexOf(0) >= 0 && played.indexOf(1) >= 0 && played.indexOf(2) >= 0 &&
        played.indexOf(3) >= 0 &&
        run.stayed.index === 4 && run.stayed.name === 'track-5.wav' &&
        run.stayed.name === run.stayed.preview && run.stayed.state !== 'Playing' &&
        run.stayed.rowClass.indexOf('playing') < 0,
      JSON.stringify(run && { seen: run.seen, stayed: run.stayed })
    );
    ws.close();
  } finally {
    child.kill('SIGTERM');
  }
}

logic().then(ui).then(() => {
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} playlist UI checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
