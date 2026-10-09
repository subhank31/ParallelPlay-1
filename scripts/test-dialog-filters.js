const { PLAYLIST_EXTENSIONS, playlistDialogOptions, mediaDialogFilters } = require('../dialog-filters');

const required = [
  'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv'
];

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function main() {
  const options = playlistDialogOptions();
  const extensions = options.filters[0].extensions;
  record(
    'playlist picker allows multiple files',
    options.properties.includes('openFile') && options.properties.includes('multiSelections'),
    options.properties.join(',')
  );
  record(
    'playlist picker has one filter so macOS cannot re-apply a video-only list',
    options.filters.length === 1,
    String(options.filters.length)
  );
  record(
    'playlist filter clears the macOS grey-out list',
    extensions.includes('*'),
    extensions[0]
  );
  const missing = required.filter((ext) => !extensions.includes(ext));
  record(
    'playlist filter lists audio and video together',
    missing.length === 0,
    missing.join(',') || extensions.filter((ext) => ext !== '*').join(',')
  );
  const audio = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus'];
  const video = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv'];
  record(
    'audio extensions are not left out of the mixed list',
    audio.every((ext) => extensions.includes(ext)) && video.every((ext) => extensions.includes(ext)),
    ''
  );
  record(
    'single-file dialog uses the same unrestricted filter',
    mediaDialogFilters().length === 1 && mediaDialogFilters()[0].extensions.includes('*') &&
      mediaDialogFilters()[0].extensions.includes('mp3'),
    ''
  );
  record(
    'known playlist extensions stay exported',
    PLAYLIST_EXTENSIONS.includes('mp3') && PLAYLIST_EXTENSIONS.includes('mkv'),
    ''
  );

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} dialog filter checks passed`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
