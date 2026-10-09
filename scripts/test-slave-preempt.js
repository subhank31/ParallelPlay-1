/**
 * The Slave runs Master commands in order, but Stop and Pause must not wait
 * behind a slow load, and a Play that arrived before them must never run after.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SlaveServer } = require('../link/slave-server');
const { MasterClient } = require('../link/master-client');
const { RecordingPlayer } = require('../link/recording-player');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A player whose load takes loadMs, like a file on a slow disk or share. */
class SlowLoadPlayer extends RecordingPlayer {
  constructor(loadMs) {
    super();
    this.loadMs = loadMs;
  }

  send(type, fields = {}) {
    if (type !== 'load') return super.send(type, fields);
    this.commands.push({ type, fields: Object.assign({}, fields), at: Date.now() });
    return wait(this.loadMs).then(() => {
      this.state = { status: 'ready', position: 0, duration: 12, rate: this.state.rate, path: fields.path };
      return { ok: true, state: Object.assign({}, this.state) };
    });
  }
}

function timed(promise) {
  const started = Date.now();
  return promise.then(
    (value) => ({ value, ms: Date.now() - started }),
    (error) => ({ error, ms: Date.now() - started })
  );
}

function typesAfter(commands, type) {
  const index = commands.map((c) => c.type).lastIndexOf(type);
  return index < 0 ? [] : commands.slice(index + 1).map((c) => c.type);
}

async function session(loadMs) {
  const player = new SlowLoadPlayer(loadMs);
  const slave = new SlaveServer({ player, host: '127.0.0.1' });
  const master = new MasterClient();
  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });
  return { player, slave, master };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-preempt-'));
  const file = path.join(dir, 'tone.wav');
  fs.writeFileSync(file, 'RIFF');

  // 1. load (slow) → play → stop: stop answers at once; play never runs after it.
  {
    const { player, slave, master } = await session(1500);
    const load = timed(master.request('load', { path: file }, 8000));
    const play = timed(master.request('play', {}, 8000));
    await wait(50);
    const stop = await timed(master.request('stop', {}, 8000));
    await Promise.all([load, play]);
    await wait(100);
    record('stop does not wait behind a slow load', stop.value && stop.value.ok && stop.ms < 500, `${stop.ms} ms`);
    const after = typesAfter(player.commands, 'stop');
    record('play sent before stop never reaches the player after stop', !after.includes('play'),
      player.commands.map((c) => c.type).join(','));
    record('slave ends stopped, not playing', player.state.status !== 'playing', player.state.status);
    master.disconnect();
    await slave.stop();
  }

  // 2. load (slow) → play → pause: pause answers at once; play does not run after it.
  {
    const { player, slave, master } = await session(1500);
    const load = timed(master.request('load', { path: file }, 8000));
    const play = timed(master.request('play', {}, 8000));
    await wait(50);
    const pause = await timed(master.request('pause', {}, 8000));
    await Promise.all([load, play]);
    await wait(100);
    record('pause does not wait behind a slow load', pause.value && pause.value.ok && pause.ms < 500, `${pause.ms} ms`);
    record('play sent before pause never reaches the player after pause',
      !typesAfter(player.commands, 'pause').includes('play'), player.commands.map((c) => c.type).join(','));
    master.disconnect();
    await slave.stop();
  }

  // 3. A play sent after stop still runs (stop only cancels what came before it).
  {
    const { player, slave, master } = await session(300);
    await master.request('load', { path: file }, 8000);
    await master.request('stop', {}, 8000);
    const play = await master.request('play', {}, 8000);
    await wait(50);
    record('play sent after stop runs normally', play.ok && player.state.status === 'playing',
      `${player.state.status} ${player.commands.map((c) => c.type).join(',')}`);
    master.disconnect();
    await slave.stop();
  }

  // 4. Ordinary commands still run in the order sent.
  {
    const { player, slave, master } = await session(200);
    const sent = [
      master.request('load', { path: file }, 8000),
      master.request('seek', { seconds: 3 }, 8000),
      master.request('setRate', { rate: 1.5 }, 8000),
      master.request('play', {}, 8000)
    ];
    const replies = await Promise.all(sent);
    const order = player.commands.map((c) => c.type).filter((t) => t !== 'getState').join(',');
    record('load, seek, rate, play keep their order', replies.every((r) => r.ok) && order === 'load,seek,setRate,play', order);
    master.disconnect();
    await slave.stop();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} slave preempt checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
