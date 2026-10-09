const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { MasterClient } = require('../link/master-client');

const root = path.join(__dirname, '..');
function packagedBinary() {
  const layouts = ['mac-universal', 'mac', 'mac-arm64', 'mac-x64'];
  for (const layout of layouts) {
    const candidate = path.join(root, 'dist', layout, 'Parallel Playout.app', 'Contents', 'MacOS', 'Parallel Playout');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(root, 'dist', 'mac-universal', 'Parallel Playout.app', 'Contents', 'MacOS', 'Parallel Playout');
}
const binary = packagedBinary();
const helperMarker = path.join('Resources', 'playout-engine', 'PlayoutEngine');
const mediaPath = process.env.PLAYOUT_MEDIA || process.argv[2];
if (!mediaPath) {
  console.error('Provide the media file with PLAYOUT_MEDIA or as the first argument.');
  process.exit(1);
}
const port = 47632;
const debugPort = 9223;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(host, listenPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: listenPort });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function cdp(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP timed out'));
    }, 20000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true
        }
      }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.result && message.result.exceptionDetails) {
        reject(new Error(JSON.stringify(message.result.exceptionDetails.exception)));
        return;
      }
      resolve(message.result.result.value);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP socket failed'));
    });
  });
}

async function main() {
  const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Parallel Playout');
  const roleFile = path.join(userDataDir, 'role.json');
  const configFile = path.join(userDataDir, 'config.json');
  const hadRole = fs.existsSync(roleFile);
  const previousRole = hadRole ? fs.readFileSync(roleFile) : null;
  const hadConfig = fs.existsSync(configFile);
  const previousConfig = hadConfig ? fs.readFileSync(configFile) : null;
  const restoreRole = () => {
    try {
      if (!hadRole) fs.unlinkSync(roleFile);
      else fs.writeFileSync(roleFile, previousRole);
    } catch (error) { /* absent */ }
    try {
      if (!hadConfig) fs.unlinkSync(configFile);
      else fs.writeFileSync(configFile, previousConfig);
    } catch (error) { /* absent */ }
  };

  // Fresh unpaired slave config for a deterministic packaged run.
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        version: 1,
        deviceId: '33333333-3333-4333-8333-333333333333',
        deviceName: 'Parallel Playout — Packaged Test Slave',
        role: 'slave',
        mediaRoot: '',
        listenPort: port,
        paired: null
      },
      null,
      2
    )
  );

  const child = spawn(binary, [`--remote-debugging-port=${debugPort}`], {
    env: Object.assign({}, process.env, {
      PLAYOUT_ROLE: 'slave',
      PLAYOUT_PORT: String(port),
      PLAYOUT_MUTE: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const stop = async () => {
    if (child.exitCode != null || child.signalCode) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(4000)
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  };

  try {
    await waitFor(() => portOpen('127.0.0.1', port), 20000, 'slave port');
    record('packaged slave listens', true, `127.0.0.1:${port}`);

    const helper = spawn('ps', ['-ax', '-o', 'command=']);
    let processes = '';
    helper.stdout.on('data', (chunk) => {
      processes += chunk.toString();
    });
    await new Promise((resolve) => helper.once('exit', resolve));
    const helperLine = processes.split('\n').find((line) => line.includes(helperMarker));
    record('bundled helper running', Boolean(helperLine), helperLine || 'PlayoutEngine process not found');

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
        const pages = await response.json();
        return pages.some((page) => page.type === 'page' && page.webSocketDebuggerUrl);
      } catch (error) {
        return false;
      }
    }, 20000, 'devtools');
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    const isolation = await cdp(page.webSocketDebuggerUrl, `({
      requireType: typeof require,
      processType: typeof process,
      hasPlay: typeof (window.electronAPI && window.electronAPI.player && window.electronAPI.player.play),
      hasPing: typeof (window.electronAPI && window.electronAPI.link && window.electronAPI.link.ping)
    })`);
    record(
      'renderer isolation',
      isolation.requireType === 'undefined' && isolation.processType === 'undefined' &&
        isolation.hasPlay === 'function' && isolation.hasPing === 'function',
      JSON.stringify(isolation)
    );

    const master = new MasterClient();
    await master.connect({ host: '127.0.0.1', port });
    const identity = {
      deviceId: '22222222-2222-4222-8222-222222222222',
      deviceName: 'Parallel Playout — Packaged Test Master',
      role: 'master'
    };
    const hello = await master.request('hello', identity);
    let pairedOk = hello.ok === true && hello.payload && hello.payload.authorized === true;
    if (!pairedOk) {
      const pairPromise = master.request('pairRequest', identity, 15000);
      await waitFor(async () => {
        const snap = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.link.snapshot()');
        return !!(
          snap &&
          snap.snapshot &&
          snap.snapshot.pendingPairRequest &&
          snap.snapshot.pendingPairRequest.requestId
        );
      }, 10000, 'pair request UI');
      const accepted = await cdp(
        page.webSocketDebuggerUrl,
        `(async () => {
          const snap = await window.electronAPI.link.snapshot();
          const id = snap.snapshot.pendingPairRequest.requestId;
          return window.electronAPI.link.acceptPairing(id);
        })()`
      );
      const paired = await pairPromise;
      pairedOk = accepted && accepted.ok === true && paired && paired.ok === true;
      record(
        'packaged pairing',
        pairedOk,
        paired && paired.ok ? 'paired' : JSON.stringify(paired && paired.error)
      );
    } else {
      record('packaged pairing', true, 'already authorized');
    }

    const ping = await master.request('ping');
    const status = await master.request('getStatus');
    record(
      'master connect ping status',
      ping.ok === true && status.ok === true && status.payload.state === 'idle',
      status.ok ? status.payload.state : JSON.stringify(status.error)
    );

    const loaded = await cdp(
      page.webSocketDebuggerUrl,
      `window.electronAPI.player.load(${JSON.stringify(mediaPath)})`
    );
    record(
      'load mp4',
      loaded && loaded.ok === true && loaded.state && loaded.state.duration > 1,
      loaded && loaded.ok ? `duration=${loaded.state.duration}` : JSON.stringify(loaded && loaded.error)
    );

    const sought = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.seek(3)');
    const playing = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.play()');
    await sleep(400);
    const paused = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.pause()');
    const stopped = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.stop()');
    const afterStop = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.getState()');
    record(
      'play pause stop',
      sought && sought.ok && playing && playing.ok && paused && paused.ok &&
        paused.state.position > 1 && stopped && stopped.ok &&
        afterStop && afterStop.ok && afterStop.state.status === 'stopped' && afterStop.state.position < 0.05,
      afterStop && afterStop.state ? `${afterStop.state.status} at ${afterStop.state.position}` : 'no state'
    );

    const resumed = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.play()');
    await sleep(300);
    const afterResume = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.player.getState()');
    record(
      'play after stop starts at the beginning',
      resumed && resumed.ok && afterResume && afterResume.ok &&
        afterResume.state.status === 'playing' && afterResume.state.position < 1.5,
      afterResume && afterResume.state ? `${afterResume.state.status} at ${afterResume.state.position}` : 'no state'
    );

    const remote = await master.request('getStatus');
    record(
      'remote status sees playback',
      remote.ok === true && remote.payload.file === mediaPath && remote.payload.position < 2,
      remote.ok ? `${remote.payload.state} ${remote.payload.position}` : JSON.stringify(remote.error)
    );
    master.disconnect();

    const snapshot = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.link.snapshot()');
    record(
      'packaged slave role',
      snapshot && snapshot.ok && snapshot.snapshot.role === 'slave' && snapshot.snapshot.listening === true &&
        snapshot.snapshot.port === port,
      snapshot && snapshot.snapshot ? `${snapshot.snapshot.role} ${snapshot.snapshot.port}` : 'no snapshot'
    );

    const switched = await cdp(
      page.webSocketDebuggerUrl,
      `(async () => {
        await window.electronAPI.link.unpair();
        const role = await window.electronAPI.link.setRole('master');
        return role;
      })()`
    );
    await sleep(400);
    const masterRole = await cdp(page.webSocketDebuggerUrl, 'window.electronAPI.link.snapshot()');
    const stillListening = await portOpen('127.0.0.1', port);
    record(
      'packaged master role',
      switched && switched.ok === true &&
        masterRole && masterRole.snapshot && masterRole.snapshot.role === 'master' && stillListening === false,
      masterRole && masterRole.snapshot
        ? `${masterRole.snapshot.role} listening=${stillListening} setRole=${JSON.stringify(switched && switched.ok)}`
        : JSON.stringify(switched)
    );
    await cdp(page.webSocketDebuggerUrl, `window.electronAPI.link.setRole('slave')`);
    await cdp(
      page.webSocketDebuggerUrl,
      `window.electronAPI.link.listen(${port})`
    );
    await waitFor(() => portOpen('127.0.0.1', port), 5000, 'slave port after reselect');
    record('slave listens again', true, String(port));
  } catch (error) {
    record('packaged app exception', false, error.stack || error.message);
    if (logs.trim()) console.log(logs.trim().split('\n').slice(-30).join('\n'));
  } finally {
    await stop();
    restoreRole();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} packaged app checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
