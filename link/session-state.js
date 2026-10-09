const { describeRecovery, playlistIndex } = require('../playlist-ui');
const fs = require('fs');
const { toRelativeMediaPath, findMediaMatch } = require('./media-path');

function fileName(filePath) {
  return String(filePath || '').split(/[/\\]/).pop();
}

/**
 * Master snapshot for a slave. File, position, duration, status, and rate come from AVPlayer.
 * Playlist index is the matching playlist row, or null when the file is not in the playlist.
 */
function masterSessionPayload(playerState, published, mediaRoot) {
  const view = describeRecovery(playerState);
  if (!view.ok) {
    return {
      ok: false,
      error: { code: 'STATE_UNAVAILABLE', message: view.reason }
    };
  }
  const playlist = Array.isArray(published && published.playlist) ? published.playlist : [];
  const items = playlist.map((entry) => {
    const absolute = typeof entry === 'string' ? entry : (entry && entry.path) || '';
    const relative = absolute ? toRelativeMediaPath(mediaRoot || '', absolute) : { ok: false };
    let sizeBytes = entry && entry.sizeBytes != null ? Number(entry.sizeBytes) : null;
    if ((sizeBytes == null || !Number.isFinite(sizeBytes)) && absolute) {
      try {
        sizeBytes = fs.statSync(absolute).size;
      } catch (error) {
        sizeBytes = null;
      }
    }
    return {
      path: absolute,
      name: (entry && entry.name) || fileName(absolute),
      type: (entry && entry.type) || null,
      duration: !entry || entry.duration == null || !Number.isFinite(Number(entry.duration)) ? null : Number(entry.duration),
      mediaPath: relative.ok ? relative.mediaPath : null,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null
    };
  });
  const index = view.idle ? -1 : playlistIndex(playlist, view.path);
  const currentRelative = !view.idle && view.path ? toRelativeMediaPath(mediaRoot || '', view.path) : { ok: false };
  return {
    ok: true,
    payload: {
      playlist: items,
      currentIndex: index >= 0 ? index : null,
      item: view.idle ? null : {
        path: view.path,
        name: view.name,
        mediaPath: currentRelative.ok ? currentRelative.mediaPath : null,
        sizeBytes: (() => {
          try {
            return fs.statSync(view.path).size;
          } catch (error) {
            return null;
          }
        })()
      },
      position: view.position,
      duration: view.duration,
      state: view.status,
      rate: view.rate,
      playAll: !!(published && published.playAll),
      playlistKnown: !!(published && published.published)
    }
  };
}

/**
 * Turn the master's item into a file on this Mac.
 * A relative media path is preferred. An absolute path is used only when that file exists here.
 */
function resolveSessionFile(item, mediaRoot, exists) {
  if (!item) return { ok: true, idle: true, path: '' };
  const resolved = findMediaMatch(mediaRoot || '', {
    mediaPath: typeof item.mediaPath === 'string' ? item.mediaPath : '',
    name: item.name,
    sizeBytes: item.sizeBytes
  });
  if (resolved.ok) {
    return { ok: true, path: resolved.absolutePath };
  }
  if (resolved.error && resolved.error.code !== 'MEDIA_NOT_FOUND') {
    return { ok: false, reason: resolved.error.message || 'The master file is not on this Mac.' };
  }
  if (typeof item.path === 'string' && item.path && typeof exists === 'function' && exists(item.path)) {
    return { ok: true, path: item.path };
  }
  return { ok: false, reason: 'The master file is not on this Mac.' };
}

module.exports = {
  masterSessionPayload,
  resolveSessionFile
};
