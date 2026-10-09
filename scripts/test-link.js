const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { MasterClient } = require('../link/master-client');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');

const mediaPath = '/tmp/parallel-playout-link-test.mp4';
const results = [];
const crashes = [];

process.on('uncaughtException', (error) => crashes.push(error.stack || error.message || String(error)));
process.on('unhandledRejection', (error) => crashes.push(error && error.stack ? error.stack : String(error)));

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLineFrom(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('no response line')), 3000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(JSON.parse(buffer.slice(0, index)));
    };
    socket.on('data', onData);
  });
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function main() {
  fs.writeFileSync(mediaPath, '');
  const player = new RecordingPlayer();
  const slave = new SlaveServer({ player, host: '127.0.0.1' });
  const master = new MasterClient();

  try {
    const listening = await slave.start(0);
    record('slave starts', Number.isInteger(listening.port) && listening.port > 0, `port=${listening.port}`);

    await master.connect({ host: '127.0.0.1', port: listening.port });
    record('master connects', master.connectionState === 'connected', master.connectionState);

    const ping = await master.request('ping');
    record(
      'ping',
      ping.ok === true && ping.type === 'response' && ping.payload.role === 'slave',
      ping.ok ? ping.payload.app : JSON.stringify(ping.error)
    );

    const status = await master.request('getStatus');
    record(
      'getStatus',
      status.ok === true && status.payload.state === 'idle' && status.payload.file === null && status.payload.position === 0,
      `state=${status.payload && status.payload.state}`
    );

    const loaded = await master.request('load', { path: mediaPath });
    const sought = await master.request('seek', { seconds: 4 });
    const playing = await master.request('play');
    const paused = await master.request('pause');
    const stopped = await master.request('stop');
    const rated = await master.request('setRate', { rate: 0.5 });
    const types = player.commands.map((command) => command.type);
    record(
      'commands reach slave',
      loaded.ok && sought.ok && playing.ok && paused.ok && stopped.ok && rated.ok &&
        JSON.stringify(types) === JSON.stringify(['getState', 'load', 'seek', 'getState', 'fullscreen', 'play', 'pause', 'stop', 'setRate']) &&
        player.commands[2].fields.seconds === 4 &&
        player.commands[8].fields.rate === 0.5 &&
        player.commands[4].fields.enabled === true &&
        types.indexOf('fullscreen') < types.indexOf('play') &&
        stopped.payload.status.state === 'stopped' &&
        stopped.payload.status.position === 0,
      types.join(',')
    );

    const relative = await master.request('load', { path: 'not-absolute.mp4' });
    const mkv = await master.request('load', { path: '/tmp/parallel-playout-link-test.mkv' });
    fs.writeFileSync('/tmp/parallel-playout-link-test.mkv', '');
    const mkvExisting = await master.request('load', { path: '/tmp/parallel-playout-link-test.mkv' });
    record(
      'unsafe paths rejected',
      relative.ok === false && mkv.ok === false && mkvExisting.ok === false &&
        player.commands.filter((command) => command.type === 'load').length === 1,
      relative.error && relative.error.code
    );

    master.disconnect();
    await sleep(30);
    const raw = net.connect({ host: '127.0.0.1', port: listening.port });
    await once(raw, 'connect');
    raw.on('error', () => {});
    const malformedPromise = readLineFrom(raw);
    raw.write('{{{not-json\n');
    const malformed = await malformedPromise;
    const stillThere = readLineFrom(raw);
    raw.write(JSON.stringify({ type: 'ping', requestId: 'raw1', payload: {} }) + '\n');
    const afterMalformed = await stillThere;
    raw.end();
    await sleep(30);
    record(
      'malformed command rejected',
      malformed.ok === false && malformed.error.code === 'MALFORMED' && afterMalformed.ok === true,
      malformed.error && malformed.error.message
    );

    await master.connect({ host: '127.0.0.1', port: listening.port });
    const intruder = net.connect({ host: '127.0.0.1', port: listening.port });
    await once(intruder, 'connect');
    intruder.on('error', () => {});
    const intruderPromise = readLineFrom(intruder);
    intruder.write(JSON.stringify({ type: 'ping', requestId: 'intruder', payload: {} }) + '\n');
    const intruderResult = await intruderPromise;
    const stillMaster = await master.request('ping');
    intruder.end();
    record(
      'unauthenticated connection cannot replace the master',
      intruderResult.ok === false && intruderResult.error.code === 'NOT_AUTHORIZED' && stillMaster.ok === true,
      intruderResult.error && intruderResult.error.code
    );
    const unknown = await master.request('shell');
    const afterUnknown = await master.request('ping');
    record(
      'unknown command rejected',
      unknown.ok === false && unknown.error.code === 'UNKNOWN_COMMAND' && afterUnknown.ok === true,
      unknown.error && unknown.error.message
    );

    master.disconnect();
    const alone = new MasterClient();
    await alone.connect({ host: '127.0.0.1', port: listening.port });
    const alonePing = await alone.request('ping');
    record('slave works with no previous master', alonePing.ok === true, alone.connectionState);
    alone.disconnect();

    const hungSockets = new Set();
    const hung = net.createServer((socket) => {
      hungSockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => hungSockets.delete(socket));
    });
    await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const slow = new MasterClient();
    await slow.connect({ host: '127.0.0.1', port: hung.address().port });
    const started = Date.now();
    let timeoutCode = '';
    try {
      await slow.request('ping', {}, 300);
      timeoutCode = 'no-timeout';
    } catch (error) {
      timeoutCode = error.code;
    }
    const elapsed = Date.now() - started;
    record('request timeout', timeoutCode === 'TIMEOUT' && elapsed >= 250 && elapsed < 2000, `${timeoutCode} ${elapsed}ms`);
    slow.disconnect();
    for (const socket of hungSockets) socket.destroy();
    await new Promise((resolve) => hung.close(resolve));

    await master.connect({ host: '127.0.0.1', port: listening.port });
    const dropped = once(master, 'disconnected');
    await slave.stop();
    await dropped;
    let afterDrop = 'threw-nothing';
    try {
      await master.request('ping');
      afterDrop = 'resolved';
    } catch (error) {
      afterDrop = error.code;
    }
    record(
      'disconnect detected',
      master.connectionState === 'disconnected' && (afterDrop === 'NOT_CONNECTED' || afterDrop === 'DISCONNECTED'),
      `${master.connectionState} ${afterDrop}`
    );

    await slave.start(listening.port);
    await master.connect({ host: '127.0.0.1', port: listening.port });
    const again = await master.request('ping');
    record('reconnect', again.ok === true && master.connectionState === 'connected', master.connectionState);
    master.disconnect();
    await slave.stop();

    const first = spawn(process.execPath, [path.join(__dirname, 'link-slave-process.js')], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const firstPort = await readListeningPort(first);
    const remote = new MasterClient();
    await remote.connect({ host: '127.0.0.1', port: firstPort });
    await remote.request('ping');
    const killed = once(remote, 'disconnected');
    first.kill('SIGKILL');
    await killed;
    record('killed slave disconnects master', remote.connectionState === 'disconnected', remote.connectionState);
    if (first.exitCode === null && first.signalCode == null) await once(first, 'exit');

    const second = spawn(process.execPath, [path.join(__dirname, 'link-slave-process.js')], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const secondPort = await readListeningPort(second);
    await remote.connect({ host: '127.0.0.1', port: secondPort });
    const revived = await remote.request('getStatus');
    record(
      'reconnect after killed slave',
      revived.ok === true && revived.payload.state === 'idle',
      revived.ok ? revived.payload.state : JSON.stringify(revived.error)
    );
    remote.disconnect();
    second.kill('SIGKILL');
    await once(second, 'exit');
  } catch (error) {
    record('link test exception', false, error.stack || error.message);
  } finally {
    master.disconnect();
    await slave.stop().catch(() => {});
    fs.unlinkSync(mediaPath);
    try { fs.unlinkSync('/tmp/parallel-playout-link-test.mkv'); } catch (error) { /* absent */ }
  }

  if (crashes.length) {
    record('no process crash', false, crashes.join(' | '));
  } else {
    record('no process crash', true);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} link checks passed`);
  return failed.length === 0 ? 0 : 1;
}

function readListeningPort(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`slave process did not listen: ${buffer}`)), 5000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/LISTENING (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.on('exit', (code) => {
      if (!/LISTENING/.test(buffer)) reject(new Error(`slave process exited ${code}`));
    });
  });
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
