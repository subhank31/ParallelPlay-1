(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaylistUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const AUDIO = new Set(['mp3', 'wav', 'aac', 'm4a', 'm4b', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'caf']);
  const VIDEO = new Set(['mp4', 'mov', 'm4v']);

  function extensionOf(filePath) {
    const name = String(filePath || '').split(/[/\\]/).pop() || '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function mediaTypeFromPath(filePath) {
    const ext = extensionOf(filePath);
    if (AUDIO.has(ext)) return 'audio';
    if (VIDEO.has(ext)) return 'video';
    return 'file';
  }

  function sameMedia(left, right) {
    const a = String(left || '').replace(/\\/g, '/');
    const b = String(right || '').replace(/\\/g, '/');
    return a !== '' && a === b;
  }

  function navigationState(index, count) {
    const multiple = count > 1;
    const atStart = index <= 0;
    const atEnd = index >= count - 1;
    return {
      previousHidden: false,
      nextHidden: false,
      previousDisabled: !multiple || atStart,
      nextDisabled: !multiple || atEnd
    };
  }

  /**
   * Index to select after the current item finishes.
   * Returns null when there is no next item, or the ended file is no longer current.
   */
  function nextIndexAfterEnd(index, count, endedPath, currentPath) {
    if (!Number.isInteger(index) || !Number.isInteger(count)) return null;
    if (count < 2 || index < 0 || index >= count - 1) return null;
    if (endedPath && currentPath && !sameMedia(endedPath, currentPath)) return null;
    return index + 1;
  }

  /**
   * Scroll offset that keeps a row inside the playlist list.
   * rowTop is the row's position in the list's scroll content.
   */
  function listScrollTop(scrollTop, viewHeight, rowTop, rowHeight) {
    const top = Number(scrollTop) || 0;
    const view = Number(viewHeight) || 0;
    const start = Number(rowTop) || 0;
    const height = Number(rowHeight) || 0;
    if (view <= 0 || height <= 0) return top;
    if (start < top) return start;
    const end = start + height;
    if (end > top + view) return Math.max(0, end - view);
    return top;
  }

  /** What to do when the current item finishes. The last item never wraps. */
  function afterEndAction(playAll, hasNext) {
    if (!hasNext) return 'stay';
    return playAll ? 'play-next' : 'select-next';
  }

  /**
   * One label for the selected item.
   * Playing is only used while that item is actually playing.
   * A cued item that is not playing is Selected / Ready.
   */
  function selectionLabel(input) {
    const hasItem = !!(input && input.hasItem);
    if (!hasItem) return { headline: 'Now playing', state: 'Idle', mark: '', mode: 'idle' };
    const status = input.status || 'ready';
    const position = Number(input.position);
    if (status === 'playing') return { headline: 'Now playing', state: 'Playing', mark: 'Playing', mode: 'playing' };
    if (status === 'paused' && Number.isFinite(position) && position > 0.05) {
      return { headline: 'Paused', state: 'Paused', mark: 'Paused', mode: 'paused' };
    }
    return { headline: 'Selected', state: 'Ready', mark: 'Selected', mode: 'ready' };
  }

  /**
   * Whether an AVPlayer snapshot is complete enough to show.
   * A playing or paused player with no file, position, duration, or rate is not usable.
   */
  function describeRecovery(state) {
    if (!state || typeof state !== 'object') {
      return { ok: false, fatal: true, reason: 'The player did not report a state after wake.' };
    }
    const status = typeof state.status === 'string' ? state.status : '';
    const file = typeof state.path === 'string' ? state.path : '';
    if ((status === '' || status === 'idle') && !file) {
      return { ok: true, idle: true, status: 'idle', path: '', name: '', position: 0, duration: null, rate: null };
    }
    const active = status === 'playing' || status === 'paused' || status === 'ready' ||
      status === 'stopped' || status === 'ended' || status === 'loading';
    if (!active || !file) {
      return {
        ok: false,
        fatal: true,
        reason: 'Playback could not be restored after wake. The player did not report which file is loaded.'
      };
    }
    const position = Number(state.position);
    const duration = Number(state.duration);
    const rate = Number(state.rate);
    const needsTime = status === 'playing' || status === 'paused' || status === 'ended';
    if (needsTime && (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0)) {
      return {
        ok: false,
        fatal: true,
        reason: 'Playback could not be restored after wake. The player did not report a position and duration.'
      };
    }
    if ((status === 'playing' || status === 'paused') && (!Number.isFinite(rate) || rate <= 0)) {
      return {
        ok: false,
        fatal: true,
        reason: 'Playback could not be restored after wake. The player did not report a playback rate.'
      };
    }
    return {
      ok: true,
      idle: false,
      fatal: false,
      path: file,
      name: file.split(/[/\\]/).pop(),
      status: status,
      position: Number.isFinite(position) && position >= 0 ? position : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      rate: Number.isFinite(rate) && rate > 0 ? rate : null
    };
  }

  function playlistIndex(files, filePath) {
    if (!Array.isArray(files)) return -1;
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const candidate = typeof entry === 'string' ? entry : (entry && entry.path);
      if (sameMedia(candidate, filePath)) return index;
    }
    return -1;
  }

  /**
   * Commands that make a local player match a master snapshot.
   * Load is skipped when the file is already current, so playback is not sent back to 0.
   */
  function reconcileCommands(local, remote) {
    const remoteState = {
      status: remote && (remote.state || remote.status),
      path: remote && remote.path,
      position: remote && remote.position,
      duration: remote && remote.duration,
      rate: remote && remote.rate
    };
    // A Slave already stopped at 00:00 needs no stop to match an idle Master.
    const needsStop = !!(local && local.path && local.status !== 'stopped' && local.status !== 'idle');
    if (remote && remote.idle === true) {
      return { ok: true, commands: needsStop ? [{ type: 'stop' }] : [] };
    }
    const viewed = describeRecovery(remoteState);
    if (!viewed.ok) return { ok: false, reason: viewed.reason };
    if (viewed.idle) return { ok: true, commands: needsStop ? [{ type: 'stop' }] : [] };
    const commands = [];
    const same = !!(local && sameMedia(local.path, viewed.path));
    if (!same) commands.push({ type: 'load', path: viewed.path });
    const localPosition = local && Number.isFinite(Number(local.position)) ? Number(local.position) : null;
    const positionDiffers = localPosition == null || Math.abs(localPosition - viewed.position) > 0.05;
    if (same ? positionDiffers : viewed.position > 0.05) {
      commands.push({ type: 'seek', seconds: viewed.position });
    }
    const localRate = local && Number.isFinite(Number(local.rate)) ? Number(local.rate) : null;
    if (viewed.rate != null && (!same || localRate == null || Math.abs(localRate - viewed.rate) > 0.001)) {
      commands.push({ type: 'setRate', rate: viewed.rate });
    }
    const localStatus = local && local.status;
    if (viewed.status === 'playing' && (!same || localStatus !== 'playing')) commands.push({ type: 'play' });
    else if ((viewed.status === 'paused' || viewed.status === 'ready' || viewed.status === 'ended') && (!same || (localStatus !== 'paused' && localStatus !== 'ready' && localStatus !== 'ended'))) {
      commands.push({ type: 'pause' });
    } else if (viewed.status === 'stopped' && (!same || localStatus !== 'stopped')) commands.push({ type: 'stop' });
    return { ok: true, commands: commands, view: viewed };
  }

  function fullscreenAvailable(typeOrPath) {
    if (typeOrPath === 'video') return true;
    if (typeOrPath === 'audio' || typeOrPath === 'file' || !typeOrPath) return false;
    return mediaTypeFromPath(typeOrPath) === 'video';
  }

  return {
    mediaTypeFromPath: mediaTypeFromPath,
    navigationState: navigationState,
    nextIndexAfterEnd: nextIndexAfterEnd,
    fullscreenAvailable: fullscreenAvailable,
    selectionLabel: selectionLabel,
    listScrollTop: listScrollTop,
    afterEndAction: afterEndAction,
    sameMedia: sameMedia,
    describeRecovery: describeRecovery,
    playlistIndex: playlistIndex,
    reconcileCommands: reconcileCommands
  };
});
