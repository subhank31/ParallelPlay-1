const { mediaPathError } = require('../player-ipc');

const COMMANDS = new Set([
  'ping',
  'getStatus',
  'load',
  'play',
  'pause',
  'stop',
  'seek',
  'setRate',
  'fullscreen',
  'openApp'
]);

const PAIRING_COMMANDS = new Set([
  'hello',
  'pairRequest',
  'pairResponse',
  'unpair'
]);

const LINK_COMMANDS = new Set([
  ...COMMANDS,
  ...PAIRING_COMMANDS,
  'timeSync',
  'scheduledPlay',
  'getSession',
  'sessionSync'
]);

/** Commands that require an authorized (paired) master when pairing is enforced. */
const AUTHORIZED_COMMANDS = new Set([
  ...COMMANDS,
  'timeSync',
  'scheduledPlay',
  'sessionSync',
  'unpair'
]);

const MAX_LINE = 524288;

function encode(message) {
  return JSON.stringify(message) + '\n';
}

function failure(requestId, code, message, extra) {
  const error = { code, message };
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return {
    type: 'response',
    requestId: requestId || null,
    ok: false,
    error
  };
}

function success(requestId, payload) {
  return {
    type: 'response',
    requestId,
    ok: true,
    payload: payload || {}
  };
}

function parseRequest(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > MAX_LINE) {
    return { ok: false, code: 'MALFORMED', message: 'Command was empty or too large.' };
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return { ok: false, code: 'MALFORMED', message: 'Command was not valid JSON.' };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, code: 'MALFORMED', message: 'Command must be a JSON object.' };
  }
  if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(message.requestId)) {
    return { ok: false, code: 'MALFORMED', message: 'requestId must be a short id string.' };
  }
  if (typeof message.type !== 'string' || message.type.length === 0 || message.type.length > 32) {
    return failure(message.requestId, 'MALFORMED', 'Command type is missing.');
  }
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload))) {
    return failure(message.requestId, 'MALFORMED', 'payload must be an object.');
  }
  const source = message.source;
  if (source !== undefined && source !== 'master' && source !== 'local' && source !== 'slave') {
    return failure(message.requestId, 'MALFORMED', 'source must be master, local, or slave.');
  }
  return {
    ok: true,
    message: {
      type: message.type,
      requestId: message.requestId,
      payload: message.payload || {},
      source: source || undefined
    }
  };
}

function endpointError(host, port) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || host.includes('..')) {
    return 'Enter a hostname or IP address.';
  }
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return 'Port must be an integer from 1 to 65535.';
  }
  return null;
}

function listenPortError(port) {
  const value = Number(port);
  if (value === 0) return null;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    return 'Listen port must be 0 or an integer from 1024 to 65535.';
  }
  return null;
}

function secondsError(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return 'Time must be a number of seconds, zero or greater.';
  }
  return null;
}

function rateError(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0 || value > 4) {
    return 'Rate must be a positive number up to 4.';
  }
  return null;
}

function identityPayloadError(payload) {
  if (!payload || typeof payload !== 'object') {
    return { code: 'INVALID_IDENTITY', message: 'Device identity is required.' };
  }
  if (typeof payload.deviceId !== 'string' || payload.deviceId.length < 8 || payload.deviceId.length > 80) {
    return { code: 'INVALID_IDENTITY', message: 'deviceId is missing or invalid.' };
  }
  if (typeof payload.deviceName !== 'string' || !payload.deviceName.trim() || payload.deviceName.length > 120) {
    return { code: 'INVALID_IDENTITY', message: 'deviceName is missing or invalid.' };
  }
  if (payload.role !== 'master' && payload.role !== 'slave') {
    return { code: 'INVALID_IDENTITY', message: 'role must be master or slave.' };
  }
  return null;
}

function normalizeStatus(playerState) {
  const raw = playerState && typeof playerState.status === 'string' ? playerState.status : 'idle';
  const mapped = {
    idle: 'idle',
    loading: 'loading',
    ready: 'stopped',
    playing: 'playing',
    paused: 'paused',
    stopped: 'stopped',
    ended: 'stopped',
    error: 'error',
    failed: 'error'
  };
  const position = playerState && Number.isFinite(playerState.position) ? playerState.position : 0;
  const duration = playerState && Number.isFinite(playerState.duration) ? playerState.duration : 0;
  const rate = playerState && Number.isFinite(playerState.rate) ? playerState.rate : 1;
  const file = playerState && typeof playerState.path === 'string' && playerState.path ? playerState.path : null;
  return {
    state: mapped[raw] || 'error',
    playerStatus: raw,
    position,
    duration,
    rate,
    file
  };
}

module.exports = {
  COMMANDS,
  PAIRING_COMMANDS,
  LINK_COMMANDS,
  AUTHORIZED_COMMANDS,
  encode,
  failure,
  success,
  parseRequest,
  endpointError,
  listenPortError,
  secondsError,
  rateError,
  identityPayloadError,
  normalizeStatus,
  mediaPathError
};
