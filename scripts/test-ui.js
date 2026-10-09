const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { ConfigStore } = require('../link/config-store');

const root = path.join(__dirname, '..');
const mediaPath = '/Users/subhank/Desktop/Finals/Sub 1.mp4';
const debugPort = 9224;
const slavePort = 47641;
const results = [];
const userDataDir = path.join(os.tmpdir(), 'pp-ui-master');
const configFile = path.join(userDataDir, 'config.json');

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')));
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      });
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timed out: ' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function main() {
  const roleFile = path.join(userDataDir, 'role.json');
  const hadRole = fs.existsSync(roleFile);
  const previousRole = hadRole ? fs.readFileSync(roleFile) : null;
  const hadConfig = fs.existsSync(configFile);
  const previousConfig = hadConfig ? fs.readFileSync(configFile) : null;
  const restoreRole = () => {
    try {
      if (!hadRole) fs.unlinkSync(roleFile);
      else fs.writeFileSync(roleFile, previousRole);
    } catch (error) { /* leave it */ }
    try {
      if (!hadConfig) fs.unlinkSync(configFile);
      else fs.writeFileSync(configFile, previousConfig);
    } catch (error) { /* leave it */ }
  };

  // Fresh unpaired master config for this UI run.
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          version: 1,
          deviceId: '11111111-1111-4111-8111-111111111111',
          deviceName: 'Parallel Playout — UI Test Master',
          role: 'master',
          mediaRoot: '',
          listenPort: 47631,
          paired: null
        },
        null,
        2
      )
    );
  } catch (error) { /* continue */ }

  const slaveCfg = new ConfigStore(path.join(os.tmpdir(), `pp-ui-slave-${Date.now()}.json`));
  slaveCfg.setRole('slave');
  slaveCfg.setDeviceName('Parallel Playout — UI Test Slave');
  const slave = new SlaveServer({
    player: new RecordingPlayer(),
    host: '127.0.0.1',
    config: slaveCfg,
    enforcePairing: true
  });
  slave.on('pair-request', (request) => {
    slave.acceptPairing(request.requestId);
  });
  await slave.start(slavePort);
  const electron = spawn(path.join(root, 'node_modules', '.bin', 'electron'), ['--remote-debugging-port=' + debugPort, '--user-data-dir=' + userDataDir, '.'], {
    cwd: root,
    env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1', PLAYOUT_ROLE: 'master' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  electron.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  electron.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  let session = null;
  const stop = async () => {
    if (session) session.close();
    if (electron.exitCode == null) electron.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => electron.once('exit', resolve)),
      sleep(4000)
    ]);
    if (electron.exitCode == null) electron.kill('SIGKILL');
    await slave.stop().catch(() => {});
    restoreRole();
  };

  try {
    let pageUrl = '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json')).json();
        const page = pages.find((item) => item.type === 'page' && item.title === 'Parallel Playout' && item.webSocketDebuggerUrl);
        if (page) {
          pageUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch (error) { /* not up */ }
      await sleep(200);
    }
    if (!pageUrl) throw new Error('devtools page missing\n' + logs.slice(-500));

    session = new CdpSession(pageUrl);
    await session.open();
    const isolation = await session.evaluate(`({
      requireType: typeof require,
      processType: typeof process,
      title: document.title,
      hasPlay: typeof window.electronAPI.player.play
    })`);
    record(
      'launch and isolation',
      isolation.requireType === 'undefined' && isolation.processType === 'undefined' && isolation.hasPlay === 'function' && isolation.title === 'Parallel Playout',
      JSON.stringify(isolation)
    );

    for (const size of [[1280, 800], [1440, 900], [1920, 1080]]) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: size[0],
        height: size[1],
        deviceScaleFactor: 1,
        mobile: false
      });
      await sleep(150);
      const layout = await session.evaluate(`(() => {
        const overflow = [];
        for (const el of document.body.querySelectorAll('*')) {
          const box = el.getBoundingClientRect();
          if (box.width > 0 && box.right > window.innerWidth + 2) overflow.push((el.id || el.className || el.tagName).toString().slice(0, 40));
          if (overflow.length > 6) break;
        }
        return {
          inner: [window.innerWidth, window.innerHeight],
          scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
          overflow: overflow.slice(0, 6),
          player: !document.getElementById('page-player').hidden,
          preview: document.getElementById('previewState').textContent
        };
      })()`);
      record(
        'layout ' + size[0] + 'x' + size[1],
        layout.inner[0] === size[0] && layout.inner[1] === size[1] && !layout.scroll && layout.overflow.length === 0 && layout.preview === 'No media loaded',
        JSON.stringify(layout)
      );
      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('/tmp/playout-ui-' + size[0] + '.png', Buffer.from(shot.data, 'base64'));
    }
    await session.send('Emulation.clearDeviceMetricsOverride');

    const pagesOk = await session.evaluate(`(async () => {
      const names = ['connection', 'diagnostics', 'settings', 'about', 'player'];
      const seen = {};
      for (const name of names) {
        document.getElementById('nav-' + name).click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        seen[name] = !document.getElementById('page-' + name).hidden;
      }
      return seen;
    })()`);
    record(
      'navigation',
      pagesOk.player && pagesOk.connection && pagesOk.diagnostics && pagesOk.settings && pagesOk.about,
      JSON.stringify(pagesOk)
    );
    for (const page of ['connection', 'diagnostics', 'settings', 'about']) {
      await session.evaluate(`document.querySelector('.nav-item[data-page="${page}"]').click()`);
      await sleep(60);
      const pageShot = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('/tmp/playout-ui-' + page + '.png', Buffer.from(pageShot.data, 'base64'));
    }
    await session.evaluate(`document.querySelector('.nav-item[data-page="player"]').click()`);

    const role = await session.evaluate(`document.getElementById('topRole').textContent`);
    record('role display', role === 'MASTER', role);

    const linkFlow = await session.evaluate(`(async () => {
      document.getElementById('nav-connection').click();
      document.getElementById('slaveHost').value = '127.0.0.1';
      document.getElementById('slavePort').value = '${slavePort}';
      await requestSlavePairing();
      const connected = document.getElementById('masterLinkLabel').textContent;
      const pairedName = document.getElementById('pairedSlaveName').textContent;
      await pingSlave();
      const ping = document.getElementById('responseBox').textContent;
      await getSlaveStatus();
      const status = document.getElementById('responseBox').textContent;
      await syncClock();
      const clock = document.getElementById('clockStatusLine').textContent;
      document.getElementById('nav-diagnostics').click();
      const scheduleVisible = !document.getElementById('clockSyncRow').hidden;
      await scheduledPlayTest();
      const scheduled = document.getElementById('responseBox').textContent;
      const unpaired = await window.electronAPI.link.unpair();
      if (unpaired && unpaired.snapshot) paintLink(unpaired.snapshot);
      const disconnected = document.getElementById('masterLinkLabel').textContent;
      return { connected, pairedName, ping, status, clock, scheduleVisible, scheduled, disconnected };
    })()`);
    record(
      'connect',
      /Connected/i.test(linkFlow.connected) && /Slave/i.test(linkFlow.pairedName),
      linkFlow.connected + ' / ' + linkFlow.pairedName
    );
    record('ping', /answered/i.test(linkFlow.ping), linkFlow.ping);
    record('get status', /Slave idle/i.test(linkFlow.status), linkFlow.status);
    record('sync clock', linkFlow.clock === 'Synchronized', linkFlow.clock + ' / ' + linkFlow.scheduled);
    record('schedule playback available', linkFlow.scheduleVisible && /scheduled/i.test(linkFlow.scheduled), linkFlow.scheduled);
    record('disconnect', /Not paired/i.test(linkFlow.disconnected), linkFlow.disconnected);

    const switched = await session.evaluate(`(async () => {
      await chooseRole('slave');
      const slave = document.getElementById('topRole').textContent;
      const listening = document.getElementById('responseBox').textContent;
      await chooseRole('master');
      const master = document.getElementById('topRole').textContent;
      return { slave, listening, master };
    })()`);
    record(
      'role switch',
      switched.slave === 'SLAVE' && /Listening on port/.test(switched.listening) && switched.master === 'MASTER',
      JSON.stringify(switched)
    );

    const playback = await session.evaluate(`(async () => {
      document.getElementById('nav-player').click();
      const loaded = await window.electronAPI.player.load(${JSON.stringify(mediaPath)});
      const sought = await window.electronAPI.player.seek(3);
      const playing = await window.electronAPI.player.play();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const paused = await window.electronAPI.player.pause();
      const stopped = await window.electronAPI.player.stop();
      const rated = await window.electronAPI.player.setRate(0.5);
      await refreshPlayer();
      return {
        loaded: loaded && loaded.ok && loaded.state.duration > 1,
        sought: sought && sought.ok,
        playing: playing && playing.ok,
        paused: paused && paused.ok && paused.state.status === 'paused',
        stopped: stopped && stopped.ok && stopped.state.status === 'stopped' && stopped.state.position < 0.05,
        rated: rated && rated.ok,
        strip: document.getElementById('stripState').textContent,
        file: document.getElementById('infoFile').textContent
      };
    })()`);
    record(
      'local play pause stop seek rate',
      playback.loaded && playback.sought && playback.playing && playback.paused && playback.stopped && playback.rated && playback.file === 'Sub 1.mp4',
      JSON.stringify(playback)
    );
  } catch (error) {
    record('ui exception', false, error.stack || error.message);
    if (logs.trim()) console.log(logs.trim().split('\n').slice(-20).join('\n'));
  } finally {
    await stop();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} ui checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
