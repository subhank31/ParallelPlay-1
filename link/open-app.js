const { spawn } = require('child_process');
const fs = require('fs');

function appBundlePath() {
  const execPath = process.execPath || '';
  const marker = '.app/Contents/MacOS/';
  const index = execPath.indexOf(marker);
  if (index === -1) return null;
  return execPath.slice(0, index + 4);
}

/**
 * Open the running Parallel Playout window.
 * When this process is the packaged app, `open` also asks macOS to activate that bundle.
 * A quit app cannot receive this command; the master reports that separately.
 */
function activateApp({ app, BrowserWindow, createWindow } = {}) {
  const windows = BrowserWindow
    ? BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed())
    : [];
  const hadWindow = windows.length > 0;
  if (!hadWindow && typeof createWindow === 'function') {
    createWindow();
  } else {
    for (const win of windows) {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      if (typeof win.show === 'function') win.show();
      if (typeof win.focus === 'function') win.focus();
    }
  }
  if (app && typeof app.focus === 'function') {
    try {
      app.focus({ steal: true });
    } catch (error) {
      app.focus();
    }
  }
  // Opening the bundle starts a second copy of the app. The running window
  // is already focused above, so only use Launch Services when nothing is open.
  const bundle = appBundlePath();
  if (!hadWindow && typeof createWindow !== 'function' && bundle && fs.existsSync(bundle)) {
    const child = spawn('/usr/bin/open', [bundle], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  if (hadWindow || typeof createWindow === 'function' || bundle) {
    return { ok: true, alreadyRunning: hadWindow, launched: !hadWindow };
  }
  return {
    ok: false,
    error: { code: 'NOT_RUNNING', message: 'Parallel Playout is not running on this Mac.' }
  };
}

module.exports = { activateApp, appBundlePath };
