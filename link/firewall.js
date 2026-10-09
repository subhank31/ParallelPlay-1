const { execFile } = require('child_process');
const fs = require('fs');

const TOOL = '/usr/libexec/ApplicationFirewall/socketfilterfw';

function run(args) {
  return new Promise((resolve) => {
    execFile(TOOL, args, { timeout: 4000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

/**
 * Reads the macOS Application Firewall rule for this app.
 * An app with no rule is reported as "permitted" by socketfilterfw, so the
 * app list is read as well to tell an approved app from one never approved.
 */
async function checkFirewall(appPath) {
  if (process.platform !== 'darwin' || !appPath || !fs.existsSync(TOOL)) return null;
  const global = await run(['--getglobalstate']);
  const enabled = /State = [12]/.test(global) || /enabled/i.test(global);
  if (!enabled) return { enabled: false, blocked: false, listed: false, appPath };
  const [blockedText, listText] = await Promise.all([
    run(['--getappblocked', appPath]),
    run(['--listapps'])
  ]);
  return {
    enabled: true,
    blocked: /is blocked/i.test(blockedText),
    listed: listText.indexOf(appPath) !== -1,
    appPath
  };
}

/**
 * Path-based firewall rules do not follow an unsigned rebuild. Re-add the
 * bundle on each listen so an inbound TCP socket stays connected long enough
 * for the Master hello. Without this, macOS accepts the socket and the first
 * read returns ENOTCONN with no peer address.
 */
async function allowFirewall(appPath) {
  const state = await checkFirewall(appPath);
  if (!state || !state.enabled) return state;
  await run(['--add', appPath]);
  await run(['--unblockapp', appPath]);
  return checkFirewall(appPath);
}

module.exports = { checkFirewall, allowFirewall };
