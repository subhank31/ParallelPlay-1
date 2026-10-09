/**
 * Extensions the Open Playlist picker must be able to select.
 * macOS NSOpenPanel greys out audio when allowedFileTypes is a fixed list.
 * Electron clears that restriction when the first filter contains "*".
 * One filter only: a second format menu would turn the restriction back on.
 */
const PLAYLIST_EXTENSIONS = [
  'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  'm4b', 'aiff', 'aif', 'caf'
];

function mediaDialogFilters() {
  return [
    {
      name: 'Audio and Video',
      extensions: ['*', ...PLAYLIST_EXTENSIONS]
    }
  ];
}

function playlistDialogOptions() {
  return {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: mediaDialogFilters(),
    title: 'Select media files or a folder'
  };
}

module.exports = {
  PLAYLIST_EXTENSIONS,
  mediaDialogFilters,
  playlistDialogOptions
};
