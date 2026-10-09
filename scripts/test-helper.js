const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { resolveHelperPath } = require('../player-session');
const binary = resolveHelperPath();
const video = process.env.PLAYOUT_TEST_VIDEO || '/Users/subhank/Desktop/Finals/Sub 1.mp4';
const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  if (!fs.existsSync(binary)) {
    record('binary exists', false, binary);
    return 1;
  }
  if (!fs.existsSync(video)) {
    record('test video exists', false, video);
    return 1;
  }

  const stderr = [];
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { PLAYOUT_MUTE: '1' })
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const pending = new Map();
  let nextId = 1;
  const events = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      stderr.push(`non-json: ${line}\n`);
      return;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.type === 'event') events.push(message);
  });

  function send(fields, timeoutMs = 20000) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${fields.type}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify(Object.assign({ id }, fields)) + '\n');
    });
  }

  async function closeHelper() {
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(1500).then(() => child.kill('SIGKILL'))
    ]);
  }

  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ready timeout')), 10000);
      const check = () => {
        const found = events.find((event) => event.event === 'ready');
        if (!found) return;
        clearTimeout(timer);
        resolve(found);
      };
      lines.on('line', check);
      check();
    });
    const displayCount = ready.state && ready.state.displays ? ready.state.displays.length : 0;
    record('helper ready', displayCount > 0, `displays=${displayCount}`);

    const mkvPath = path.join('/tmp', 'parallel-playout-unsupported.mkv');
    fs.writeFileSync(mkvPath, '');
    const mkv = await send({ type: 'load', path: mkvPath });
    record(
      'reject mkv',
      mkv.ok === false && /not supported/.test(mkv.error || '') && /\.mkv/.test(mkv.error || ''),
      mkv.error || 'unexpected success'
    );

    const missing = await send({ type: 'load', path: '/tmp/parallel-playout-missing.mp4' });
    record('missing file', missing.ok === false && /File not found/.test(missing.error || ''), missing.error || '');

    const loaded = await send({ type: 'load', path: video }, 30000);
    const duration = loaded.state && loaded.state.duration;
    record(
      'load mp4',
      loaded.ok === true && loaded.state.status === 'ready' && typeof duration === 'number' && duration > 1,
      `status=${loaded.state && loaded.state.status} duration=${duration}`
    );
    if (!loaded.ok) throw new Error(loaded.error || 'load failed');

    const target = Math.min(8, duration * 0.4);
    const sought = await send({ type: 'seek', seconds: target });
    const seekDelta = Math.abs(sought.state.position - target);
    record('seek', sought.ok === true && seekDelta < 0.75, `position=${sought.state.position} target=${target}`);

    const playing = await send({ type: 'play' });
    await sleep(400);
    const whilePlaying = await send({ type: 'getState' });
    record(
      'play',
      playing.ok === true && whilePlaying.state.status === 'playing' && whilePlaying.state.position > target - 0.25,
      `status=${whilePlaying.state.status} position=${whilePlaying.state.position}`
    );

    const paused = await send({ type: 'pause' });
    const pausedAt = paused.state.position;
    record(
      'pause',
      paused.ok === true && paused.state.status === 'paused' && pausedAt > 1,
      `position=${pausedAt}`
    );

    await send({ type: 'play' });
    await sleep(400);
    const resumedPause = await send({ type: 'getState' });
    record(
      'play resumes from the paused position',
      resumedPause.state.status === 'playing' && resumedPause.state.position > pausedAt - 0.25,
      `paused=${pausedAt} now=${resumedPause.state.position}`
    );
    await send({ type: 'pause' });

    const stopped = await send({ type: 'stop' });
    const stoppedAt = stopped.state.position;
    record(
      'stop returns to the start',
      stopped.ok === true && stopped.state.status === 'stopped' && stoppedAt < 0.05,
      `position=${stoppedAt}`
    );

    await send({ type: 'play' });
    await sleep(400);
    const resumed = await send({ type: 'getState' });
    record(
      'play after stop starts at the beginning',
      resumed.state.status === 'playing' && resumed.state.position < 1.5,
      `now=${resumed.state.position}`
    );
    await send({ type: 'pause' });

    for (const rate of [0.5, 1, 1.5]) {
      const rated = await send({ type: 'setRate', rate });
      record(
        `setRate ${rate}`,
        rated.ok === true && Math.abs(rated.state.rate - rate) < 0.01,
        `rate=${rated.state && rated.state.rate}`
      );
    }
    await send({ type: 'play' });
    await sleep(200);
    const slow = await send({ type: 'setRate', rate: 0.5 });
    record(
      'actual rate while playing',
      slow.ok === true && Math.abs(slow.state.actualRate - 0.5) < 0.05,
      `actualRate=${slow.state.actualRate}`
    );
    await send({ type: 'pause' });

    const display = await send({ type: 'setDisplay', displayIndex: 0 });
    record(
      'setDisplay 0',
      display.ok === true && display.state.displayIndex === 0 &&
        Array.isArray(display.state.displays) &&
        display.state.displays.every((item) => item.width > 0 && item.height > 0 && typeof item.name === 'string'),
      display.error || `index=${display.state && display.state.displayIndex}`
    );
    const missingDisplay = await send({ type: 'setDisplay', displayIndex: 99 });
    record(
      'setDisplay uses this Mac’s live screen list',
      missingDisplay.ok === false && display.state.displayIndex === 0,
      missingDisplay.error || ''
    );

    const fullOn = await send({ type: 'fullscreen', enabled: true });
    let fullState = fullOn;
    const fullDeadline = Date.now() + 5000;
    while (Date.now() < fullDeadline && !(fullState.state && fullState.state.fullscreen)) {
      await sleep(200);
      fullState = await send({ type: 'getState' });
    }
    const screen = fullState.state && fullState.state.displays
      ? fullState.state.displays[fullState.state.displayIndex]
      : null;
    record('fullscreen on', !!(fullState.state && fullState.state.fullscreen), `fullscreen=${fullState.state && fullState.state.fullscreen}`);
    record(
      'fullscreen fills the selected display',
      !!(screen && fullState.state.windowWidth > 0 &&
        Math.abs(fullState.state.windowWidth - screen.width) <= 2 &&
        Math.abs(fullState.state.windowHeight - screen.height) <= 2),
      `window=${fullState.state && fullState.state.windowWidth}x${fullState.state && fullState.state.windowHeight} display=${screen && screen.width}x${screen && screen.height}`
    );
    record(
      'paused fullscreen keeps the cursor visible',
      fullState.state && fullState.state.cursorHidden === false,
      `cursorHidden=${fullState.state && fullState.state.cursorHidden}`
    );
    await send({ type: 'play' });
    let hiddenState = await send({ type: 'getState' });
    const hideDeadline = Date.now() + 2000;
    while (Date.now() < hideDeadline && !(hiddenState.state && hiddenState.state.cursorHidden)) {
      await sleep(100);
      hiddenState = await send({ type: 'getState' });
    }
    record(
      'playing fullscreen hides the cursor',
      !!(hiddenState.state && hiddenState.state.fullscreen && hiddenState.state.cursorHidden),
      `cursorHidden=${hiddenState.state && hiddenState.state.cursorHidden}`
    );
    const revealed = await send({ type: 'pause' });
    record(
      'leaving playback shows the cursor',
      revealed.state && revealed.state.cursorHidden === false,
      `cursorHidden=${revealed.state && revealed.state.cursorHidden}`
    );

    await send({ type: 'fullscreen', enabled: false });
    let restored = await send({ type: 'getState' });
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline && restored.state && restored.state.fullscreen) {
      await sleep(200);
      restored = await send({ type: 'getState' });
    }
    record('fullscreen off', restored.state && restored.state.fullscreen === false, `fullscreen=${restored.state && restored.state.fullscreen}`);

    const host = (await send({ type: 'getState' })).state.hostTime;
    const scheduled = await send({
      type: 'scheduledPlay',
      seconds: Math.min(3, duration * 0.2),
      rate: 1,
      hostTime: host + 0.45
    });
    await sleep(900);
    const afterSchedule = await send({ type: 'getState' });
    const scheduledTarget = Math.min(3, duration * 0.2);
    record(
      'scheduledPlay',
      scheduled.ok === true && afterSchedule.state.status === 'playing' && afterSchedule.state.position >= scheduledTarget - 0.35,
      `status=${afterSchedule.state.status} position=${afterSchedule.state.position} target=${scheduledTarget}`
    );
  } catch (error) {
    record('helper test exception', false, error.message);
    if (stderr.length) console.error(stderr.join('').slice(-2000));
  } finally {
    await closeHelper();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} helper checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
