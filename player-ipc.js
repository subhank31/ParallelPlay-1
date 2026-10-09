const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.aac', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.aiff', '.aif', '.caf'
]);
const SUPPORTED = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const UNSUPPORTED = new Set(['.avi', '.mkv', '.wmv', '.flv', '.webm']);

function mediaKind(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'file';
}

function fileNameOf(filePath) {
  return path.basename(String(filePath || ''));
}

/** Keep the order the operator selected. Do not sort. */
function describeSelection(filePaths) {
  if (!Array.isArray(filePaths)) return [];
  return filePaths.filter((filePath) => typeof filePath === 'string' && filePath).map((filePath) => ({
    path: filePath,
    name: fileNameOf(filePath),
    type: mediaKind(filePath),
    duration: null
  }));
}

/**
 * Turn a file-or-folder selection into playable files.
 * Selected files stay in the order they were picked.
 * A folder is replaced by the audio and video inside it, including subfolders,
 * in numeric filename order. Unsupported files in a folder are skipped.
 */
function expandPlaylistSelection(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const files = [];
  const seen = new Set();
  const visitedDirs = new Set();
  let rejected = null;

  function considerFile(filePath, explicit) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    const error = mediaPathError(resolved);
    if (error) {
      if (explicit) rejected = rejected || error;
      return;
    }
    seen.add(resolved);
    files.push(resolved);
  }

  function walk(dir) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (error) {
      rejected = rejected || `File not found: ${dir}`;
      return;
    }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (error) {
      rejected = rejected || `File not found: ${dir}`;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue;
      const full = path.join(real, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) considerFile(full, false);
    }
  }

  for (const input of inputs) {
    if (typeof input !== 'string' || !input) continue;
    let stat;
    try {
      stat = fs.statSync(input);
    } catch (error) {
      rejected = rejected || `File not found: ${input}`;
      continue;
    }
    if (stat.isDirectory()) walk(input);
    else considerFile(input, true);
  }

  if (files.length === 0) {
    throw new Error(rejected || 'That folder has no supported audio or video files.');
  }
  return files;
}

function mediaPathError(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return 'A file path is required.';
  }
  if (!path.isAbsolute(filePath)) {
    return 'The file path must be absolute.';
  }
  const extension = path.extname(filePath).toLowerCase();
  if (UNSUPPORTED.has(extension) || !SUPPORTED.has(extension)) {
    const shown = extension || 'This format';
    return `Unable to play this file. ${shown} is not supported.`;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return `File not found: ${filePath}`;
  }
  if (!stat.isFile()) return `File not found: ${filePath}`;
  return null;
}

function rateError(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0 || value > 4) {
    return 'Rate must be a positive number up to 4.';
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

function registerPlayerIpc({ ipcMain, BrowserWindow, session }) {
  function broadcast(payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('player:event', payload);
    }
  }

  session.on('event', broadcast);

  async function attempt(work) {
    try {
      return await work();
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  ipcMain.handle('player:load', (_event, filePath) => {
    const error = mediaPathError(filePath);
    if (error) return { ok: false, error };
    return attempt(() => session.send('load', { path: filePath }, 30000));
  });

  ipcMain.handle('player:play', () => attempt(() => session.send('play')));
  ipcMain.handle('player:pause', () => attempt(() => session.send('pause')));
  ipcMain.handle('player:stop', () => attempt(() => session.send('stop')));

  ipcMain.handle('player:seek', (_event, seconds) => {
    const error = secondsError(seconds);
    if (error) return { ok: false, error };
    return attempt(() => session.send('seek', { seconds: Number(seconds) }));
  });

  ipcMain.handle('player:setRate', (_event, rate) => {
    const error = rateError(rate);
    if (error) return { ok: false, error };
    return attempt(() => session.send('setRate', { rate: Number(rate) }));
  });

  ipcMain.handle('player:getState', () => attempt(() => session.send('getState', {}, 5000)));
  ipcMain.handle('player:recover', () => attempt(() => session.send('recover', {}, 8000)));

  ipcMain.handle('player:inspect', async (_event, filePath) => {
    const error = mediaPathError(filePath);
    if (error) return { ok: false, error };
    try {
      const message = await session.send('inspect', { path: filePath }, 20000);
      if (!message || message.ok === false) {
        return { ok: false, error: (message && message.error) || 'Could not read this file.' };
      }
      const duration = Number(message.duration);
      return {
        ok: true,
        path: filePath,
        duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
        mediaType: message.mediaType || mediaKind(filePath)
      };
    } catch (inspectError) {
      return { ok: false, error: inspectError.message };
    }
  });

  ipcMain.handle('player:fullscreen', (_event, enabled) => {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'Fullscreen requires true or false.' };
    }
    return attempt(() => session.send('fullscreen', { enabled }));
  });

  ipcMain.handle('player:setDisplay', (_event, displayIndex) => {
    if (!Number.isInteger(displayIndex) || displayIndex < 0) {
      return { ok: false, error: 'Display index must be an integer, zero or greater.' };
    }
    return attempt(() => session.send('setDisplay', { displayIndex }));
  });

  ipcMain.handle('player:scheduledPlay', (_event, options) => {
    const source = options && typeof options === 'object' ? options : {};
    const fields = {};
    if (source.seconds !== undefined && source.seconds !== null) {
      const error = secondsError(source.seconds);
      if (error) return { ok: false, error };
      fields.seconds = Number(source.seconds);
    }
    if (source.rate !== undefined && source.rate !== null) {
      const error = rateError(source.rate);
      if (error) return { ok: false, error };
      fields.rate = Number(source.rate);
    }
    if (source.hostTime !== undefined && source.hostTime !== null) {
      const hostTime = Number(source.hostTime);
      if (!Number.isFinite(hostTime)) {
        return { ok: false, error: 'hostTime must be a finite number of seconds.' };
      }
      fields.hostTime = hostTime;
    }
    return attempt(() => session.send('scheduledPlay', fields));
  });
}

module.exports = {
  registerPlayerIpc,
  mediaPathError,
  mediaKind,
  describeSelection,
  expandPlaylistSelection,
  SUPPORTED,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS
};
