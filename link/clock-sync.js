// Application-level clock estimate. This is not NTP and does not speak NTP.
//
// Each side stamps its own monotonic clock. Those clocks do not share an
// origin, and their raw values must not be compared directly. Node's
// process.hrtime.bigint() is used because it does not follow wall-clock
// changes (manual time, timezone, daylight saving, or a step from the
// operating system's time service). Swift's mach clock is a different
// clock and is not read here.
//
// Units: milliseconds, as a JavaScript number, including fractions.
// Origin: the first load of this module in that process. Not the Unix
// epoch. A later reading is milliseconds since that process-local origin.
//
// Four stamps for one exchange:
//   t0  master send,    master clock
//   t1  slave receive,  slave clock
//   t2  slave send,     slave clock
//   t3  master receive, master clock
//
//   rttMs    = (t3 - t0) - (t2 - t1)
//   offsetMs = ((t1 - t0) + (t2 - t3)) / 2
//
// offsetMs estimates (slave clock - master clock) at the same instant.
// Positive means the slave's monotonic reading is ahead of the master's.
// Convert with: slaveTarget = masterTarget + offsetMs.
//
// An uneven path biases that estimate. If the master-to-slave delay and
// the slave-to-master delay differ by D milliseconds, the estimate is
// shifted by about D / 2. Several samples are taken and obvious outliers
// are dropped before the median is kept.

const originNs = process.hrtime.bigint();

function monotonicNow() {
  return Number(process.hrtime.bigint() - originNs) / 1e6;
}

// Shared by both Macs: milliseconds since the Unix epoch, with a
// fractional part. This is not the process-local monotonic clock.
// Diagnostics use it so two apps that started at different times do not
// report that startup gap as a clock offset.
function sharedNow() {
  return performance.timeOrigin + performance.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyEstimate(samples) {
  return {
    offsetMs: null,
    rttMs: null,
    sampleCount: 0,
    jitterMs: null,
    synchronized: false,
    rejectedCount: samples ? samples.length : 0,
    samples: samples || []
  };
}

function measureSample({ t0, t1, t2, t3 }) {
  return {
    t0,
    t1,
    t2,
    t3,
    rttMs: (t3 - t0) - (t2 - t1),
    offsetMs: ((t1 - t0) + (t2 - t3)) / 2
  };
}

function timeSyncPayloadError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: 'MALFORMED', message: 'timeSync payload must be an object.' };
  }
  const extra = Object.keys(payload).filter((key) => key !== 't0');
  if (extra.length) {
    return { code: 'UNSAFE_PAYLOAD', message: 'timeSync only accepts t0.' };
  }
  if (typeof payload.t0 !== 'number' || !Number.isFinite(payload.t0)) {
    return { code: 'MALFORMED', message: 't0 must be a finite number.' };
  }
  return null;
}

// Drop samples with a negative or non-finite RTT. Then drop RTT spikes
// above max(3× median RTT, median RTT + 20 ms). From what remains, drop
// offset samples farther than max(3× median absolute deviation, 5 ms)
// from the median offset. The reported offset and RTT are medians of the
// samples still left. jitterMs is the spread (max − min) of those offsets.
function selectEstimate(samples, options = {}) {
  const minimumSamples = options.minimumSamples == null ? 3 : options.minimumSamples;
  const decorated = (samples || []).map((sample) => Object.assign({}, sample, {
    accepted: false,
    rejectReason: null
  }));
  const finite = [];
  for (const sample of decorated) {
    if (!Number.isFinite(sample.rttMs) || sample.rttMs < 0 || !Number.isFinite(sample.offsetMs)) {
      sample.rejectReason = 'invalid';
    } else {
      finite.push(sample);
    }
  }
  if (!finite.length) return emptyEstimate(decorated);

  const medianRtt = median(finite.map((sample) => sample.rttMs));
  const rttLimit = Math.max(medianRtt * 3, medianRtt + 20);
  const rttKept = [];
  for (const sample of finite) {
    if (sample.rttMs > rttLimit) sample.rejectReason = 'rtt-outlier';
    else rttKept.push(sample);
  }
  if (!rttKept.length) return emptyEstimate(decorated);

  const medianOffset = median(rttKept.map((sample) => sample.offsetMs));
  const mad = median(rttKept.map((sample) => Math.abs(sample.offsetMs - medianOffset)));
  const offsetLimit = Math.max(mad * 3, 5);
  const offsetKept = [];
  for (const sample of rttKept) {
    if (Math.abs(sample.offsetMs - medianOffset) > offsetLimit) sample.rejectReason = 'offset-outlier';
    else offsetKept.push(sample);
  }

  const used = offsetKept.length >= minimumSamples ? offsetKept : rttKept;
  if (used === rttKept && used !== offsetKept) {
    for (const sample of rttKept) {
      sample.rejectReason = null;
      sample.accepted = true;
    }
  } else {
    for (const sample of offsetKept) sample.accepted = true;
  }

  const offsets = used.map((sample) => sample.offsetMs);
  return {
    offsetMs: median(offsets),
    rttMs: median(used.map((sample) => sample.rttMs)),
    sampleCount: used.length,
    jitterMs: Math.max(...offsets) - Math.min(...offsets),
    synchronized: used.length >= minimumSamples,
    rejectedCount: decorated.length - used.length,
    samples: decorated
  };
}

function slaveTimeForMasterTime(masterTime, offsetMs) {
  return masterTime + offsetMs;
}

async function synchronize(request, options = {}) {
  const sampleCount = options.sampleCount == null ? 10 : options.sampleCount;
  const intervalMs = options.intervalMs == null ? 20 : options.intervalMs;
  const clock = options.clock || { monotonicNow };
  const wait = options.sleep || sleep;
  const samples = [];
  const wallSamples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const t0 = clock.monotonicNow();
    const w0 = typeof clock.sharedNow === 'function' ? clock.sharedNow() : sharedNow();
    let response;
    try {
      response = await request({ t0 });
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code || 'LINK_ERROR', message: error.message },
        estimate: emptyEstimate(samples)
      };
    }
    if (!response || response.ok === false) {
      return {
        ok: false,
        error: (response && response.error) || { code: 'LINK_ERROR', message: 'timeSync failed.' },
        estimate: emptyEstimate(samples)
      };
    }
    const payload = response.payload || {};
    if (payload.t0 !== t0 || !Number.isFinite(payload.t1) || !Number.isFinite(payload.t2)) {
      return {
        ok: false,
        error: { code: 'MALFORMED', message: 'timeSync response did not echo usable timestamps.' },
        estimate: emptyEstimate(samples)
      };
    }
    const t3 = Number.isFinite(response.receivedAt) ? response.receivedAt : clock.monotonicNow();
    const w3 = Number.isFinite(response.receivedWall)
      ? response.receivedWall
      : (typeof clock.sharedNow === 'function' ? clock.sharedNow() : sharedNow());
    samples.push(measureSample({ t0, t1: payload.t1, t2: payload.t2, t3 }));
    if (Number.isFinite(payload.w1) && Number.isFinite(payload.w2)) {
      wallSamples.push(measureSample({ t0: w0, t1: payload.w1, t2: payload.w2, t3: w3 }));
    }
    if (index < sampleCount - 1 && intervalMs > 0) await wait(intervalMs);
  }
  const estimate = selectEstimate(samples, options);
  if (wallSamples.length) estimate.diagnostic = selectEstimate(wallSamples, options);
  if (!estimate.synchronized) {
    return {
      ok: false,
      error: { code: 'NOT_SYNCHRONIZED', message: 'Not enough stable clock samples.' },
      estimate
    };
  }
  return { ok: true, estimate };
}

module.exports = {
  monotonicNow,
  sharedNow,
  measureSample,
  selectEstimate,
  synchronize,
  slaveTimeForMasterTime,
  timeSyncPayloadError,
  emptyEstimate
};
