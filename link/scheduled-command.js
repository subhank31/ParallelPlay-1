const { slaveTimeForMasterTime } = require('./clock-sync');

const SCHEDULE_FIELDS = new Set(['targetMasterTime', 'localTargetTime']);
const DEFAULT_LEAD_MS = 1000;

function leadTimeMs(value) {
  if (value == null || value === '') return DEFAULT_LEAD_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60000) return null;
  return parsed;
}

function defaultLeadMs() {
  const parsed = leadTimeMs(process.env.MASTER_SCHEDULE_LEAD_MS);
  return parsed == null ? DEFAULT_LEAD_MS : parsed;
}

function scheduledPlayPayloadError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: 'MALFORMED', message: 'scheduledPlay payload must be an object.' };
  }
  const extra = Object.keys(payload).filter((key) => !SCHEDULE_FIELDS.has(key));
  if (extra.length) {
    return {
      code: 'UNSAFE_PAYLOAD',
      message: 'scheduledPlay only accepts targetMasterTime and localTargetTime.'
    };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'targetMasterTime') ||
      !Object.prototype.hasOwnProperty.call(payload, 'localTargetTime')) {
    return { code: 'MALFORMED', message: 'scheduledPlay requires targetMasterTime and localTargetTime.' };
  }
  if (typeof payload.targetMasterTime !== 'number' || !Number.isFinite(payload.targetMasterTime) ||
      typeof payload.localTargetTime !== 'number' || !Number.isFinite(payload.localTargetTime)) {
    return { code: 'MALFORMED', message: 'scheduledPlay times must be finite numbers.' };
  }
  return null;
}

// The master picks a target on its own clock at least leadMs ahead, then
// converts with slaveTarget = masterTarget + offsetMs. This does not play.
function planScheduledPlay({ masterNow, offsetMs, leadMs, targetMasterTime }) {
  if (!Number.isFinite(masterNow) || !Number.isFinite(offsetMs) || !Number.isFinite(leadMs) || leadMs < 0) {
    return { ok: false, error: { code: 'MALFORMED', message: 'Schedule inputs must be finite numbers.' } };
  }
  const target = Number.isFinite(targetMasterTime) ? targetMasterTime : masterNow + leadMs;
  if (target < masterNow + leadMs) {
    return {
      ok: false,
      error: {
        code: 'TOO_SOON',
        message: `Scheduled time must be at least ${leadMs} ms ahead of the master clock.`
      }
    };
  }
  return {
    ok: true,
    targetMasterTime: target,
    localTargetTime: slaveTimeForMasterTime(target, offsetMs),
    leadMs
  };
}

// One timer against the slave's monotonic clock. When it fires, the
// existing player play command runs. This does not call Swift scheduledPlay
// and it does not poll the master.
class CommandScheduler {
  constructor({ clock, player, setTimer, clearTimer } = {}) {
    if (!clock || typeof clock.monotonicNow !== 'function') {
      throw new Error('CommandScheduler requires a monotonic clock.');
    }
    if (!player || typeof player.send !== 'function') {
      throw new Error('CommandScheduler requires a player.');
    }
    this.clock = clock;
    this.player = player;
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((timer) => clearTimeout(timer));
    this.pending = null;
    this.lastExecution = null;
    this.onExecuted = null;
  }

  accept(payload) {
    const problem = scheduledPlayPayloadError(payload);
    if (problem) return { ok: false, error: problem };
    const now = this.clock.monotonicNow();
    if (payload.localTargetTime <= now) {
      return {
        ok: false,
        error: { code: 'STALE', message: 'Scheduled time is already in the past on this Mac.' }
      };
    }
    this.cancel();
    const localTargetTime = payload.localTargetTime;
    const masterTargetTime = payload.targetMasterTime;
    const token = {};
    const timer = this.setTimer(() => {
      if (!this.pending || this.pending.token !== token) return;
      this.pending = null;
      const actualLocalTime = this.clock.monotonicNow();
      const execution = {
        masterTargetTime,
        localTargetTime,
        actualLocalTime,
        errorMs: actualLocalTime - localTargetTime
      };
      this.lastExecution = execution;
      Promise.resolve()
        .then(() => this.player.send('play', {}))
        .then(() => {
          if (typeof this.onExecuted === 'function') this.onExecuted(execution);
        })
        .catch((error) => {
          execution.playError = error && error.message ? error.message : String(error);
          if (typeof this.onExecuted === 'function') this.onExecuted(execution);
        });
    }, localTargetTime - now);
    this.pending = { timer, token, localTargetTime, masterTargetTime };
    return {
      ok: true,
      payload: {
        scheduled: true,
        localTargetTime,
        masterTargetTime
      }
    };
  }

  cancel() {
    if (!this.pending) return;
    this.clearTimer(this.pending.timer);
    this.pending = null;
  }
}

module.exports = {
  DEFAULT_LEAD_MS,
  leadTimeMs,
  defaultLeadMs,
  scheduledPlayPayloadError,
  planScheduledPlay,
  CommandScheduler
};
