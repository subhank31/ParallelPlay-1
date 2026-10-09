const { MasterClient } = require('../link/master-client');
const { SlaveServer } = require('../link/slave-server');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');
const {
  measureSample,
  selectEstimate,
  synchronize,
  slaveTimeForMasterTime,
  monotonicNow,
  sharedNow
} = require('../link/clock-sync');
const { planScheduledPlay, CommandScheduler } = require('../link/scheduled-command');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

class FakeClock {
  constructor(start) {
    this.time = start;
    this.timers = [];
    this.nextId = 1;
  }

  monotonicNow() {
    return this.time;
  }

  setTimer(fn, delayMs) {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + delayMs, fn, fired: false });
    return id;
  }

  clearTimer(id) {
    const timer = this.timers.find((item) => item.id === id);
    if (timer) timer.fired = true;
  }

  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      let next = null;
      for (const timer of this.timers) {
        if (timer.fired || timer.at > end) continue;
        if (!next || timer.at < next.at) next = timer;
      }
      if (!next) break;
      this.time = next.at;
      next.fired = true;
      next.fn();
    }
    this.time = end;
  }
}

function simulatedSample({ masterAt, offsetMs, delayOutMs, delayBackMs, processingMs = 0 }) {
  const t0 = masterAt;
  const t1 = masterAt + delayOutMs + offsetMs;
  const t2 = t1 + processingMs;
  const t3 = masterAt + delayOutMs + processingMs + delayBackMs;
  return measureSample({ t0, t1, t2, t3 });
}

async function fakeExchange(trueOffset, delayOutMs, delayBackMs) {
  const master = new FakeClock(1000);
  return synchronize(async ({ t0 }) => {
    const t1 = t0 + delayOutMs + trueOffset;
    const t2 = t1;
    master.advance(delayOutMs + delayBackMs);
    return { ok: true, payload: { t0, t1, t2 } };
  }, {
    sampleCount: 10,
    intervalMs: 5,
    clock: master,
    sleep: async (ms) => master.advance(ms)
  });
}

async function main() {
  const symmetric = simulatedSample({
    masterAt: 0, offsetMs: 50, delayOutMs: 20, delayBackMs: 20
  });
  record(
    'timeSync calculation',
    symmetric.offsetMs === 50 && symmetric.rttMs === 40 && symmetric.t0 === 0 && symmetric.t1 === 70 && symmetric.t3 === 40,
    `offset=${symmetric.offsetMs} rtt=${symmetric.rttMs}`
  );

  const ahead = await fakeExchange(50, 20, 20);
  const behind = await fakeExchange(-50, 20, 20);
  const further = await fakeExchange(200, 20, 20);
  record(
    'multiple samples',
    ahead.ok && ahead.estimate.sampleCount === 10 && behind.estimate.sampleCount === 10,
    `count=${ahead.estimate.sampleCount}`
  );
  record('RTT calculated', ahead.estimate.rttMs === 40, `rtt=${ahead.estimate.rttMs}`);
  record(
    'offset calculated',
    ahead.estimate.offsetMs === 50 && behind.estimate.offsetMs === -50 && further.estimate.offsetMs === 200,
    `+50=${ahead.estimate.offsetMs} -50=${behind.estimate.offsetMs} +200=${further.estimate.offsetMs}`
  );

  const uneven = simulatedSample({
    masterAt: 0, offsetMs: 50, delayOutMs: 20, delayBackMs: 30
  });
  const unevenBias = (20 - 30) / 2;
  record(
    'asymmetric delay follows the formula',
    uneven.rttMs === 50 && uneven.offsetMs === 50 + unevenBias,
    `true=+50 measured=${uneven.offsetMs} rtt=${uneven.rttMs} bias=${unevenBias}`
  );

  const cluster = [];
  for (let index = 0; index < 9; index += 1) {
    cluster.push(simulatedSample({
      masterAt: index * 100, offsetMs: 50, delayOutMs: 20, delayBackMs: 20
    }));
  }
  cluster.push(simulatedSample({
    masterAt: 1000, offsetMs: 50, delayOutMs: 400, delayBackMs: 400
  }));
  const rttFiltered = selectEstimate(cluster);
  const offsetCluster = [48, 49, 50, 51, 52, 50, 49, 51, 50, 50].map((offsetMs, index) => simulatedSample({
    masterAt: index * 100, offsetMs, delayOutMs: 20, delayBackMs: 20
  }));
  offsetCluster.push(measureSample({ t0: 0, t1: 5000, t2: 5000, t3: 40 }));
  const offsetFiltered = selectEstimate(offsetCluster);
  const wild = offsetFiltered.samples.find((sample) => sample.offsetMs > 1000);
  record(
    'outlier handling',
    rttFiltered.offsetMs === 50 && rttFiltered.rejectedCount === 1 && rttFiltered.sampleCount === 9 &&
      offsetFiltered.offsetMs === 50 && wild && wild.accepted === false,
    `rttReject=${rttFiltered.rejectedCount} offsetReject=${wild && wild.rejectReason}`
  );
  const stable = selectEstimate(offsetCluster.slice(0, 10));
  record(
    'stable offset exposed',
    stable.synchronized === true && stable.offsetMs === 50 && stable.sampleCount === 10 &&
      stable.jitterMs === 4 && stable.rttMs === 40,
    `offset=${stable.offsetMs} rtt=${stable.rttMs} jitter=${stable.jitterMs} samples=${stable.sampleCount} synchronized=${stable.synchronized}`
  );

  console.log('SIMULATED measurements (not LAN accuracy)');
  console.log(`  symmetric +50 ms, 20/20 ms -> offset ${ahead.estimate.offsetMs} ms, rtt ${ahead.estimate.rttMs} ms`);
  console.log(`  symmetric -50 ms, 20/20 ms -> offset ${behind.estimate.offsetMs} ms, rtt ${behind.estimate.rttMs} ms`);
  console.log(`  symmetric +200 ms, 20/20 ms -> offset ${further.estimate.offsetMs} ms, rtt ${further.estimate.rttMs} ms`);
  console.log(`  asymmetric +50 ms true, 20/30 ms -> offset ${uneven.offsetMs} ms, rtt ${uneven.rttMs} ms, bias ${unevenBias} ms`);
  console.log(`  jitter cluster -> offset ${stable.offsetMs} ms, jitter ${stable.jitterMs} ms`);

  const masterOrigin = sharedNow();
  const slaveOrigin = masterOrigin + 8857.991;
  let instant = masterOrigin + 20000;
  const masterClock = {
    monotonicNow: () => instant - masterOrigin,
    sharedNow: () => instant
  };
  const slaveClock = {
    monotonicNow: () => instant - slaveOrigin,
    sharedNow: () => instant
  };
  const separated = [];
  const separatedWall = [];
  for (let index = 0; index < 8; index += 1) {
    const t0 = masterClock.monotonicNow();
    const w0 = masterClock.sharedNow();
    instant += 1;
    const t1 = slaveClock.monotonicNow();
    const w1 = slaveClock.sharedNow();
    instant += 0.2;
    const t2 = slaveClock.monotonicNow();
    const w2 = slaveClock.sharedNow();
    instant += 1;
    const t3 = masterClock.monotonicNow();
    const w3 = masterClock.sharedNow();
    separated.push(measureSample({ t0, t1, t2, t3 }));
    separatedWall.push(measureSample({ t0: w0, t1: w1, t2: w2, t3: w3 }));
    instant += 5;
  }
  const processSkew = selectEstimate(separated);
  const sameBasis = selectEstimate(separatedWall);
  record(
    'process start gap is not the diagnostic offset',
    processSkew.offsetMs < -8800 && Math.abs(sameBasis.offsetMs) < 1 &&
      sameBasis.rttMs > 0 && sameBasis.rttMs < 5 && sameBasis.jitterMs < 1,
    `process=${processSkew.offsetMs} shared=${sameBasis.offsetMs} rtt=${sameBasis.rttMs} jitter=${sameBasis.jitterMs}`
  );

  for (const offsetMs of [50, -50, 200]) {
    const plan = planScheduledPlay({ masterNow: 10000, offsetMs, leadMs: 1000 });
    const expectedLocal = slaveTimeForMasterTime(11000, offsetMs);
    record(
      `master/slave conversion ${offsetMs}`,
      plan.ok === true && plan.targetMasterTime === 11000 && plan.localTargetTime === expectedLocal,
      `master=11000 slave=${plan.localTargetTime}`
    );
  }
  const tooSoon = planScheduledPlay({
    masterNow: 0, offsetMs: 0, leadMs: 1000, targetMasterTime: 100
  });
  record('lead time enforced', tooSoon.ok === false && tooSoon.error.code === 'TOO_SOON', tooSoon.error && tooSoon.error.code);

  const player = new RecordingPlayer();
  const clock = new FakeClock(1000);
  const scheduler = new CommandScheduler({
    clock,
    player,
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (id) => clock.clearTimer(id)
  });
  const slave = new SlaveServer({ player, host: '127.0.0.1', clock, scheduler });
  const master = new MasterClient();

  try {
    const listening = await slave.start(0);
    await master.connect({ host: '127.0.0.1', port: listening.port });
    const sync = await master.request('timeSync', { t0: 42 });
    record(
      'timeSync request',
      sync.ok === true && sync.payload.t0 === 42 && sync.payload.t1 === 1000 && sync.payload.t2 === 1000 &&
        Number.isFinite(sync.receivedAt),
      `t1=${sync.payload && sync.payload.t1} t2=${sync.payload && sync.payload.t2}`
    );

    const badTime = await master.request('timeSync', { t0: 'now' });
    const unsafeTime = await master.request('timeSync', { t0: 1, command: 'shell' });
    record(
      'unsafe timeSync rejected',
      badTime.ok === false && badTime.error.code === 'MALFORMED' &&
        unsafeTime.ok === false && unsafeTime.error.code === 'UNSAFE_PAYLOAD',
      `${badTime.error && badTime.error.code} ${unsafeTime.error && unsafeTime.error.code}`
    );

    const stale = await master.request('scheduledPlay', { targetMasterTime: 1000, localTargetTime: 1000 });
    const malformed = await master.request('scheduledPlay', { targetMasterTime: 'soon', localTargetTime: 2000 });
    const missing = await master.request('scheduledPlay', { targetMasterTime: 2000 });
    const unsafe = await master.request('scheduledPlay', {
      targetMasterTime: 5000,
      localTargetTime: 5000,
      shell: 'rm',
      path: '/tmp/x'
    });
    record(
      'stale scheduled command rejected',
      stale.ok === false && stale.error.code === 'STALE' && player.commands.length === 0,
      stale.error && stale.error.code
    );
    record(
      'malformed scheduledPlay rejected',
      malformed.ok === false && malformed.error.code === 'MALFORMED' &&
        missing.ok === false && missing.error.code === 'MALFORMED',
      `${malformed.error && malformed.error.code}/${missing.error && missing.error.code}`
    );
    record(
      'unsafe payload rejected',
      unsafe.ok === false && unsafe.error.code === 'UNSAFE_PAYLOAD' && player.commands.length === 0,
      unsafe.error && unsafe.error.code
    );

    const executionPromise = once(master, 'execution');
    const accepted = await master.request('scheduledPlay', {
      targetMasterTime: 5000,
      localTargetTime: 2000
    });
    record(
      'scheduledPlay accepted',
      accepted.ok === true && accepted.payload.scheduled === true &&
        accepted.payload.localTargetTime === 2000 && accepted.payload.masterTargetTime === 5000 &&
        accepted.payload.actualLocalTime === undefined,
      `scheduled=${accepted.payload && accepted.payload.scheduled}`
    );
    record(
      'scheduledPlay does not execute immediately',
      player.commands.some((command) => command.type === 'play') === false,
      `commands=${player.commands.map((command) => command.type).join(',')}`
    );
    clock.advance(999);
    await flush();
    record(
      'scheduledPlay waits for the target',
      clock.monotonicNow() === 1999 && player.commands.some((command) => command.type === 'play') === false,
      `clock=${clock.monotonicNow()}`
    );
    clock.advance(1);
    const execution = await executionPromise;
    await flush();
    record(
      'scheduledPlay executes near target time',
      player.commands.filter((command) => command.type === 'play').length === 1 &&
        player.commands.some((command) => command.type === 'scheduledPlay') === false &&
        execution.actualLocalTime === 2000 && execution.errorMs === 0,
      `target=2000 actual=${execution.actualLocalTime} errorMs=${execution.errorMs}`
    );
    record(
      'local execution timestamp recorded',
      scheduler.lastExecution && scheduler.lastExecution.actualLocalTime === 2000 &&
        scheduler.lastExecution.errorMs === 0 && execution.localTargetTime === 2000,
      `errorMs=${execution.errorMs}`
    );
    console.log('SIMULATED scheduled execution');
    console.log(`  target ${execution.localTargetTime} actual ${execution.actualLocalTime} error ${execution.errorMs} ms`);

    master.disconnect();
    let disconnectedCode = '';
    try {
      await master.request('scheduledPlay', { targetMasterTime: 9000, localTargetTime: 9000 });
      disconnectedCode = 'resolved';
    } catch (error) {
      disconnectedCode = error.code;
    }
    const offline = new LinkController(new RecordingPlayer());
    offline.syncState = { synchronized: true, offsetMs: 10, sampleCount: 10 };
    const offlineSchedule = await offline.scheduledPlayTest();
    record(
      'disconnected slave fails cleanly',
      disconnectedCode === 'NOT_CONNECTED' && offlineSchedule.ok === false &&
        (offlineSchedule.error.code === 'NOT_CONNECTED' || offlineSchedule.error.code === 'LINK_ERROR'),
      `${disconnectedCode} ${offlineSchedule.error && offlineSchedule.error.code}`
    );

    const later = new MasterClient();
    await later.connect({ host: '127.0.0.1', port: listening.port });
    const afterMasterLeft = await later.request('scheduledPlay', {
      targetMasterTime: 4000,
      localTargetTime: 4000
    });
    later.disconnect();
    clock.advance(2000);
    await flush();
    record(
      'slave runs the schedule without the master',
      afterMasterLeft.ok === true && player.commands.filter((command) => command.type === 'play').length === 2 &&
        scheduler.lastExecution.actualLocalTime === 4000 && scheduler.lastExecution.errorMs === 0,
      `actual=${scheduler.lastExecution && scheduler.lastExecution.actualLocalTime}`
    );
  } catch (error) {
    record('clock protocol exception', false, error.stack || error.message);
  } finally {
    master.disconnect();
    scheduler.cancel();
    await slave.stop().catch(() => {});
  }

  const realPlayer = new RecordingPlayer();
  const realSlave = new SlaveServer({ player: realPlayer, host: '127.0.0.1' });
  const realLink = new LinkController(realPlayer, { sampleIntervalMs: 5, leadMs: 40 });
  try {
    const listening = await realSlave.start(0);
    await realLink.connect('127.0.0.1', listening.port);
    const synced = await realLink.syncClock();
    const clockInfo = synced.clock || {};
    record(
      'localhost clock sync',
      synced.ok === true && clockInfo.synchronized === true && clockInfo.sampleCount >= 3 &&
        Number.isFinite(clockInfo.offsetMs) && Math.abs(clockInfo.offsetMs) < 20 &&
        Number.isFinite(clockInfo.rttMs) && clockInfo.rttMs >= 0 && clockInfo.rttMs < 50 &&
        Number.isFinite(clockInfo.jitterMs) && clockInfo.jitterMs < 20,
      `offset=${clockInfo.offsetMs} rtt=${clockInfo.rttMs} jitter=${clockInfo.jitterMs} samples=${clockInfo.sampleCount}`
    );
    console.log('LOCALHOST clock sync (same machine, not a two-Mac result)');
    console.log(`  offset ${clockInfo.offsetMs} ms`);
    console.log(`  rtt ${clockInfo.rttMs} ms`);
    console.log(`  jitter ${clockInfo.jitterMs} ms`);
    console.log(`  samples ${clockInfo.sampleCount}`);
    console.log(`  synchronized ${clockInfo.synchronized}`);

    const executionPromise = new Promise((resolve) => {
      const onEvent = (event) => {
        if (event && event.event === 'execution') {
          realLink.off('event', onEvent);
          resolve(event);
        }
      };
      realLink.on('event', onEvent);
      setTimeout(() => {
        realLink.off('event', onEvent);
        resolve(null);
      }, 1000);
    });
    const scheduled = await realLink.scheduledPlayTest();
    record(
      'localhost scheduledPlay accepted',
      scheduled.ok === true && scheduled.payload.scheduled === true &&
        scheduled.payload.actualLocalTime === undefined &&
        scheduled.plan.localTargetTime === scheduled.plan.targetMasterTime + realLink.syncState.offsetMs,
      `lead=${scheduled.plan && scheduled.plan.leadMs} local=${scheduled.plan && scheduled.plan.localTargetTime}`
    );
    const execution = await executionPromise;
    record(
      'localhost execution measured',
      !!execution && Number.isFinite(execution.errorMs) && Math.abs(execution.errorMs) < 250 &&
        realPlayer.commands.some((command) => command.type === 'play'),
      execution ? `target=${execution.localTargetTime} actual=${execution.actualLocalTime} errorMs=${execution.errorMs}` : 'no execution'
    );
    if (execution) {
      console.log('LOCALHOST scheduled execution (same machine, not a two-Mac result)');
      console.log(`  master target ${scheduled.plan.targetMasterTime}`);
      console.log(`  slave local target ${execution.localTargetTime}`);
      console.log(`  actual ${execution.actualLocalTime}`);
      console.log(`  error ${execution.errorMs} ms`);
    }
  } catch (error) {
    record('localhost clock exception', false, error.stack || error.message);
  } finally {
    await realLink.shutdown();
    await realSlave.stop().catch(() => {});
  }

  const timed = new RecordingPlayer();
  const localScheduler = new CommandScheduler({ clock: { monotonicNow }, player: timed });
  const started = monotonicNow();
  let localExecution = null;
  localScheduler.onExecuted = (execution) => {
    localExecution = execution;
  };
  const localPlan = localScheduler.accept({ targetMasterTime: started + 40, localTargetTime: started + 40 });
  const immediate = timed.commands.some((command) => command.type === 'play');
  const waitForLocal = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (localExecution) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 500);
  });
  await waitForLocal;
  localScheduler.cancel();
  record(
    'real timer records execution error',
    localPlan.ok === true && immediate === false && localExecution && Number.isFinite(localExecution.errorMs) &&
      Math.abs(localExecution.errorMs) < 250,
    localExecution ? `target=${localExecution.localTargetTime} actual=${localExecution.actualLocalTime} errorMs=${localExecution.errorMs}` : 'no execution'
  );
  if (localExecution) {
    console.log('LOCAL process timer (not a network result)');
    console.log(`  target ${localExecution.localTargetTime}`);
    console.log(`  actual ${localExecution.actualLocalTime}`);
    console.log(`  error ${localExecution.errorMs} ms`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} clock checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
