/**
 * Races against the real PlayoutEngine: commands sent while a file is still
 * loading. Stop and Pause must never leave a load waiting, and a Play sent
 * before Stop must never start playback after it.
 */
process.env.PLAYOUT_MUTE = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayerSession } = require('../player-session');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 16-bit mono PCM sine, long enough that it never ends during a check. */
function writeTone(file, seconds) {
  const rate = 22050;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function timed(promise) {
  const started = Date.now();
  return promise.then(
    (value) => ({ value, ms: Date.now() - started }),
    (error) => ({ error, ms: Date.now() - started })
  );
}

async function state(session) {
  const reply = await session.send('getState', {}, 3000);
  return reply && reply.state ? reply.state : {};
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-races-'));
  const a = path.join(dir, 'a.wav');
  const b = path.join(dir, 'b.wav');
  writeTone(a, 30);
  writeTone(b, 30);

  const session = new PlayerSession();
  const opened = [];
  session.on('log', (line) => { if (/opened /.test(line)) opened.push(line); });
  session.start();
  await state(session);

  // 1. Stop while loading: the load must still answer quickly, and stay stopped.
  {
    const load = timed(session.send('load', { path: a }, 8000));
    const stop = timed(session.send('stop', {}, 8000));
    const [l, s] = await Promise.all([load, stop]);
    await wait(300);
    const now = await state(session);
    record('stop during load answers at once', s.value && s.value.ok === true && s.ms < 1000,
      `${s.ms} ms ${s.error ? s.error.message : (s.value && s.value.error) || ''}`);
    record('load interrupted by stop still completes', l.value && l.value.ok === true && l.ms < 3000,
      `${l.ms} ms ${l.error ? l.error.message : (l.value && l.value.error) || ''}`);
    record('player stays stopped at 0 after load', now.status === 'stopped' && now.position < 0.05,
      `${now.status} @ ${now.position}`);
  }

  // 2. Play then Stop while loading: playback must not start afterwards.
  {
    const load = timed(session.send('load', { path: b }, 8000));
    const play = session.send('play', {}, 8000);
    const stop = session.send('stop', {}, 8000);
    await Promise.allSettled([load, play, stop]);
    const l = await load;
    await wait(600);
    const now = await state(session);
    record('load followed by play and stop completes', l.value && l.value.ok === true && l.ms < 3000,
      `${l.ms} ms ${l.error ? l.error.message : (l.value && l.value.error) || ''}`);
    record('play queued before stop does not start after load', now.status !== 'playing' && now.position < 0.05,
      `${now.status} @ ${now.position}`);
  }

  // 3. Pause while loading leaves the item paused, not playing.
  {
    const load = timed(session.send('load', { path: a }, 8000));
    const play = session.send('play', {}, 8000);
    const pause = timed(session.send('pause', {}, 8000));
    const settled = await Promise.allSettled([load, play, pause]);
    const p = await pause;
    const l = await load;
    record('load interrupted by pause still completes', l.value && l.value.ok === true && l.ms < 3000,
      `${l.ms} ms ${l.error ? l.error.message : (l.value && l.value.error) || ''}`);
    await wait(600);
    const now = await state(session);
    record('pause during load answers at once', p.value && p.value.ok === true && p.ms < 1000, `${p.ms} ms`);
    record('play queued before pause does not start after load', now.status !== 'playing',
      `${now.status} @ ${now.position} (${settled.map((r) => r.status).join(',')})`);
  }

  // 4. Seek then Play while loading both run, in order.
  {
    const load = session.send('load', { path: b }, 8000);
    const seek = session.send('seek', { seconds: 5 }, 8000);
    const play = session.send('play', {}, 8000);
    const [, s, p] = await Promise.allSettled([load, seek, play]);
    await wait(500);
    const now = await state(session);
    record('seek and play queued during load both run', s.value && s.value.ok && p.value && p.value.ok &&
      now.status === 'playing' && now.position >= 5,
      `seek=${s.value && s.value.ok} ${(s.value && s.value.error) || ''} play=${p.value && p.value.ok} ${now.status} @ ${now.position}`);
    await session.send('stop', {}, 8000);
  }

  // 5. Three loads of the same file attach it once and all answer.
  {
    opened.length = 0;
    const loads = await Promise.all([1, 2, 3].map(() => timed(session.send('load', { path: a }, 8000))));
    await wait(300);
    const slowest = Math.max(...loads.map((l) => l.ms));
    record('repeated loads of one file all answer quickly', loads.every((l) => l.value) && slowest < 3000,
      `${slowest} ms; ${loads.map((l) => (l.value && l.value.ok) ? 'ok' : 'replaced').join(',')}`);
    record('repeated loads of one file open it once', opened.length === 1, `${opened.length} opened`);
    const now = await state(session);
    record('last load leaves the item ready', now.status === 'ready' && now.path === a, `${now.status}`);
  }

  // 6. Stop with nothing loaded yet but a load in flight is not an error.
  {
    await session.shutdown();
    const fresh = new PlayerSession();
    fresh.start();
    await state(fresh);
    const load = fresh.send('load', { path: b }, 8000);
    const stop = await fresh.send('stop', {}, 8000).catch((e) => ({ ok: false, error: e.message }));
    await load.catch(() => null);
    record('stop during the very first load is accepted', stop && stop.ok === true, (stop && stop.error) || '');
    await fresh.shutdown();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} engine race checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
