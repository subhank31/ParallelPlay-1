const fs = require('fs');
const path = require('path');
const { SUPPORTED } = require('../player-ipc');

/**
 * Convert an absolute local file path into a relative media path under root.
 * Returns null if the file is outside the media root.
 */
function toRelativeMediaPath(mediaRoot, absolutePath) {
  if (typeof mediaRoot !== 'string' || !mediaRoot || !path.isAbsolute(mediaRoot)) {
    return { ok: false, error: { code: 'NO_MEDIA_ROOT', message: 'Configure a media directory first.' } };
  }
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    return { ok: false, error: { code: 'INVALID_MEDIA', message: 'Media path must be absolute on this Mac.' } };
  }
  const root = path.resolve(mediaRoot);
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      error: {
        code: 'OUTSIDE_MEDIA_ROOT',
        message: 'That file is outside the configured media directory.'
      }
    };
  }
  return { ok: true, mediaPath: rel.split(path.sep).join('/') };
}

function fileNameOf(value) {
  if (typeof value !== 'string' || !value) return '';
  return path.basename(value.replace(/\\/g, '/'));
}

function walkMediaFiles(mediaRoot, visit) {
  const root = path.resolve(mediaRoot);
  const queue = [root];
  const seenDirs = new Set();
  while (queue.length) {
    const dir = queue.shift();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (error) {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.')) continue;
      const full = path.join(real, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED.has(extension)) continue;
        visit(full);
      }
    }
  }
}

/**
 * Resolve a relative media path against the configured root (strict layout match).
 */
function resolveMediaPath(mediaRoot, mediaPath) {
  if (typeof mediaRoot !== 'string' || !mediaRoot || !path.isAbsolute(mediaRoot)) {
    return {
      ok: false,
      error: { code: 'NO_MEDIA_ROOT', message: 'Configure a media directory on this Mac.' }
    };
  }
  if (typeof mediaPath !== 'string' || !mediaPath.trim()) {
    return {
      ok: false,
      error: { code: 'INVALID_MEDIA', message: 'A relative media path is required.' }
    };
  }
  const trimmed = mediaPath.trim().replace(/\\/g, '/');
  if (trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.split('/').some((p) => p === '..')) {
    return {
      ok: false,
      error: { code: 'PATH_TRAVERSAL', message: 'Media path must stay inside the media directory.' }
    };
  }
  const root = path.resolve(mediaRoot);
  const absolute = path.resolve(root, ...trimmed.split('/').filter(Boolean));
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      error: { code: 'PATH_TRAVERSAL', message: 'Media path must stay inside the media directory.' }
    };
  }
  const extension = path.extname(absolute).toLowerCase();
  if (!SUPPORTED.has(extension)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MEDIA',
        message: `Unable to play this file. ${extension || 'This format'} is not supported.`
      }
    };
  }
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_NOT_FOUND',
        message: `MEDIA NOT FOUND ON SLAVE\nFile: ${trimmed}`,
        mediaPath: trimmed
      }
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_NOT_FOUND',
        message: `MEDIA NOT FOUND ON SLAVE\nFile: ${trimmed}`,
        mediaPath: trimmed
      }
    };
  }
  return { ok: true, absolutePath: absolute, mediaPath: trimmed, sizeBytes: stat.size };
}

/**
 * Resolve media on this Mac: relative path first, then filename + byte size.
 * Never picks arbitrarily among duplicates.
 */
function findMediaMatch(mediaRoot, hints) {
  const mediaPath = hints && typeof hints.mediaPath === 'string' ? hints.mediaPath.trim() : '';
  if (mediaPath) {
    const byPath = resolveMediaPath(mediaRoot, mediaPath);
    if (byPath.ok) return byPath;
  }
  const name = fileNameOf(hints && hints.name) || fileNameOf(mediaPath);
  if (!name) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_NOT_FOUND',
        message: 'MEDIA NOT FOUND ON SLAVE\nNo file name was provided to match.',
        mediaPath: mediaPath || name
      }
    };
  }
  const wantSize = hints && hints.sizeBytes != null ? Number(hints.sizeBytes) : null;
  const byName = [];
  walkMediaFiles(mediaRoot, (absolutePath) => {
    if (path.basename(absolutePath) === name) {
      let size = null;
      try {
        size = fs.statSync(absolutePath).size;
      } catch (error) {
        return;
      }
      byName.push({ absolutePath, size });
    }
  });
  if (byName.length === 0) {
    return {
      ok: false,
      error: {
        code: 'MEDIA_NOT_FOUND',
        message: `MEDIA NOT FOUND ON SLAVE\nFile: ${mediaPath || name}`,
        mediaPath: mediaPath || name
      }
    };
  }
  let candidates = byName;
  if (wantSize != null && Number.isFinite(wantSize)) {
    const sized = byName.filter((entry) => entry.size === wantSize);
    if (sized.length === 1) {
      candidates = sized;
    } else if (sized.length > 1) {
      return {
        ok: false,
        error: {
          code: 'DUPLICATE_MEDIA',
          message:
            `More than one file named "${name}" with size ${wantSize} bytes exists under the media directory. ` +
            'Fix the duplicate files or use the same folder layout as the Master.',
          mediaPath: mediaPath || name
        }
      };
    } else if (byName.length > 1) {
      return {
        ok: false,
        error: {
          code: 'DUPLICATE_MEDIA',
          message:
            `More than one file named "${name}" exists under the media directory and none match size ${wantSize} bytes.`,
          mediaPath: mediaPath || name
        }
      };
    }
  } else if (byName.length > 1) {
    return {
      ok: false,
      error: {
        code: 'DUPLICATE_MEDIA',
        message:
          `More than one file named "${name}" exists under the media directory. ` +
          'Use matching folder layout or ensure file sizes differ.',
        mediaPath: mediaPath || name
      }
    };
  }
  const chosen = candidates[0];
  const relative = toRelativeMediaPath(mediaRoot, chosen.absolutePath);
  return {
    ok: true,
    absolutePath: chosen.absolutePath,
    mediaPath: relative.ok ? relative.mediaPath : (mediaPath || name),
    sizeBytes: chosen.size
  };
}

module.exports = {
  toRelativeMediaPath,
  resolveMediaPath,
  findMediaMatch,
  SUPPORTED
};
