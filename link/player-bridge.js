const path = require('path');
const {
  COMMANDS,
  mediaPathError,
  secondsError,
  rateError,
  normalizeStatus
} = require('./protocol');
const { findMediaMatch } = require('./media-path');

/** Seek only when the slave is further than this from the master's position. */
const POSITION_TOLERANCE_SECONDS = 0.05;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.aiff', '.aif', '.caf']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

function isAudioFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isVideoFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function enterFullscreenForVideo(player, source, mediaPath) {
  if (source !== 'master') return;
  const result = await player.send('getState', {}, 5000);
  const state = result && result.ok !== false ? result.state : null;
  const loaded = state && typeof state.path === 'string' ? state.path : '';
  const named = typeof mediaPath === 'string' ? mediaPath : '';
  if (isAudioFile(named) || isAudioFile(loaded)) return;
  if (!isVideoFile(named) && !isVideoFile(loaded)) return;
  if (state && state.fullscreen === true) return;
  await player.send('fullscreen', { enabled: true }, 10000).catch(() => null);
}

function playerFailure(result) {
  return {
    ok: false,
    error: {
      code: 'PLAYER_ERROR',
      message: (result && result.error) || 'Player command failed.'
    }
  };
}

/**
 * A later Stop or Pause from the Master has overtaken this command. It is
 * answered as done without touching the player, so it cannot run late.
 */
function overtaken(context) {
  return !!(context && typeof context.isCurrent === 'function' && !context.isCurrent());
}

const SUPERSEDED = { ok: true, payload: { superseded: true } };

async function playerResult(player, type, fields, timeoutMs) {
  const result = await player.send(type, fields, timeoutMs);
  if (!result || result.ok === false) return playerFailure(result);
  return { ok: true, payload: { status: normalizeStatus(result.state) } };
}

/**
 * @param {object} player
 * @param {object} command
 * @param {{ mediaRoot?: string }} [context]
 */
async function execute(player, command, context = {}) {
  const payload = command.payload || {};
  if (!COMMANDS.has(command.type)) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_COMMAND', message: `Unknown command: ${command.type}` }
    };
  }

  // Remote master commands must never be echoed back to the master.
  // Local UI may still drive the player; source is recorded for debugging.
  const source = command.source || payload.source || 'master';

  if (command.type === 'ping') {
    return {
      ok: true,
      payload: { app: 'Sri Sathya Sai Parallel Playout', role: 'slave', source }
    };
  }

  if (command.type === 'getStatus') {
    const result = await player.send('getState', {}, 5000);
    if (!result || result.ok === false) return playerFailure(result);
    return { ok: true, payload: normalizeStatus(result.state) };
  }

  if (command.type === 'load') {
    let absolutePath = null;
    let mediaPath = null;

    if (typeof payload.mediaPath === 'string' && payload.mediaPath.trim()) {
      const resolved = findMediaMatch(context.mediaRoot || '', {
        mediaPath: payload.mediaPath,
        name: payload.name,
        sizeBytes: payload.sizeBytes
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      absolutePath = resolved.absolutePath;
      mediaPath = resolved.mediaPath;
    } else if (typeof payload.path === 'string') {
      // Absolute path remains supported for diagnostics / existing unit tests.
      const problem = mediaPathError(payload.path);
      if (problem) return { ok: false, error: { code: 'INVALID_MEDIA', message: problem } };
      absolutePath = payload.path;
    } else {
      return {
        ok: false,
        error: { code: 'INVALID_MEDIA', message: 'load requires mediaPath or path.' }
      };
    }

    const loaded = await playerResult(player, 'load', { path: absolutePath }, 30000);
    if (!loaded.ok) return loaded;
    if (mediaPath) loaded.payload.mediaPath = mediaPath;
    loaded.payload.path = absolutePath;
    return loaded;
  }

  if (command.type === 'seek') {
    const problem = secondsError(payload.seconds);
    if (problem) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: problem } };
    const identity = await confirmMedia(player, payload, context);
    if (!identity.ok) return identity;
    if (overtaken(context)) return SUPERSEDED;
    const sought = await playerResult(player, 'seek', { seconds: Number(payload.seconds) }, 15000);
    if (!sought.ok) return sought;
    return holdPlaybackState(player, payload.state, source, sought, payload.mediaPath, context);
  }

  if (command.type === 'setRate') {
    const problem = rateError(payload.rate);
    if (problem) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: problem } };
    return playerResult(player, 'setRate', { rate: Number(payload.rate) }, 15000);
  }

  if (command.type === 'fullscreen') {
    const enabled = payload.enabled !== false;
    return playerResult(player, 'fullscreen', { enabled }, 15000);
  }

  if (command.type === 'play') {
    if (overtaken(context)) return SUPERSEDED;
    const prepared = await prepareTransport(player, payload, context);
    if (!prepared.ok) return prepared;
    // Video enters fullscreen before playback. Audio never does.
    // An already-fullscreen window is left alone.
    await enterFullscreenForVideo(player, source, payload.mediaPath);
    if (overtaken(context)) return SUPERSEDED;
    return playerResult(player, 'play', {}, 15000);
  }

  if (command.type === 'pause') {
    const prepared = await prepareTransport(player, payload, context);
    if (!prepared.ok) return prepared;
    if (overtaken(context)) return SUPERSEDED;
    return playerResult(player, 'pause', {}, 15000);
  }

  if (command.type === 'stop') {
    if (overtaken(context)) return SUPERSEDED;
    return playerResult(player, 'stop', {}, 15000);
  }

  if (command.type === 'openApp') {
    if (typeof context.openApp !== 'function') {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message: 'Parallel Playout is not running on this Mac.'
        }
      };
    }
    try {
      const opened = await context.openApp();
      if (!opened || opened.ok === false) {
        return {
          ok: false,
          error: (opened && opened.error) || {
            code: 'OPEN_FAILED',
            message: 'Could not open Parallel Playout on the slave.'
          }
        };
      }
      return {
        ok: true,
        payload: {
          opened: true,
          alreadyRunning: opened.alreadyRunning !== false
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'OPEN_FAILED', message: error.message || 'Could not open Parallel Playout on the slave.' }
      };
    }
  }

  return playerResult(player, command.type, {}, 15000);
}

function toleranceSeconds(context) {
  const value = context && context.positionToleranceSeconds;
  if (Number.isFinite(value) && value >= 0) return value;
  return POSITION_TOLERANCE_SECONDS;
}

async function readStatus(player) {
  const result = await player.send('getState', {}, 5000);
  if (!result || result.ok === false) return playerFailure(result);
  return { ok: true, status: normalizeStatus(result.state) };
}

/**
 * When the master names the media, the slave must already have that file.
 * This never loads. A load would move the playhead back to 0.
 */
async function confirmMedia(player, payload, context) {
  if (!payload || typeof payload.mediaPath !== 'string' || !payload.mediaPath.trim()) {
    return { ok: true };
  }
  const current = await readStatus(player);
  if (!current.ok) return current;
  const resolved = findMediaMatch(context.mediaRoot || '', {
    mediaPath: payload.mediaPath,
    name: payload.name,
    sizeBytes: payload.sizeBytes
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (!current.status.file) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_NOT_LOADED',
        message: 'Slave does not have this media loaded.',
        mediaPath: resolved.mediaPath
      }
    };
  }
  if (path.resolve(current.status.file) !== path.resolve(resolved.absolutePath)) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_MISMATCH',
        message: 'Slave has different media loaded.',
        mediaPath: resolved.mediaPath
      }
    };
  }
  return { ok: true, status: current.status };
}

async function prepareTransport(player, payload, context) {
  const hasPosition = payload && payload.position != null;
  const hasMedia = payload && typeof payload.mediaPath === 'string' && payload.mediaPath.trim();
  if (!hasPosition && !hasMedia) return { ok: true, sought: false };

  const identity = await confirmMedia(player, payload, context);
  if (!identity.ok) return identity;
  if (!hasPosition) return { ok: true, sought: false, status: identity.status };

  const problem = secondsError(payload.position);
  if (problem) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: problem } };
  const current = identity.status ? identity : await readStatus(player);
  if (!current.ok) return current;

  const target = Number(payload.position);
  const delta = Math.abs(current.status.position - target);
  if (delta <= toleranceSeconds(context)) {
    return { ok: true, sought: false, status: current.status };
  }
  if (overtaken(context)) return { ok: true, sought: false, status: current.status };
  const sought = await playerResult(player, 'seek', { seconds: target }, 15000);
  if (!sought.ok) return sought;
  return { ok: true, sought: true, status: sought.payload.status };
}

async function holdPlaybackState(player, state, source, currentResult, mediaPath, context) {
  if (state !== 'playing' && state !== 'paused') return currentResult;
  if (overtaken(context)) return currentResult;
  const status = currentResult.payload && currentResult.payload.status;
  const now = status && status.state;
  if (state === 'paused') {
    if (now === 'paused') return currentResult;
    return playerResult(player, 'pause', {}, 15000);
  }
  if (now === 'playing') return currentResult;
  const played = await playerResult(player, 'play', {}, 15000);
  if (!played.ok) return played;
  await enterFullscreenForVideo(player, source, mediaPath);
  return played;
}

module.exports = { execute, POSITION_TOLERANCE_SECONDS };
