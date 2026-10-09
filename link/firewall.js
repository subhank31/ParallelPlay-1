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
 * True when the bundle carries a full code signature. A bundle with only the
 * linker's signature on the executable has no designated requirement, and the
 * Application Firewall drops every inbound flow for it even when the app is
 * listed as "Allow incoming connections". The Master then sees 0 bytes and the
 * Slave's first read fails with ENOTCONN.
 */
function checkSignature(appPath) {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 8000 }, (error) => {
      resolve(!error);
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
  if (!enabled) return { enabled: false, blocked: false, listed: false, signed: true, appPath };
  const [blockedText, listText, signed] = await Promise.all([
    run(['--getappblocked', appPath]),
    run(['--listapps']),
    /\.app$/.test(appPath) ? checkSignature(appPath) : Promise.resolve(true)
  ]);
  return {
    enabled: true,
    blocked: /is blocked/i.test(blockedText),
    listed: listText.indexOf(appPath) !== -1,
    signed,
    appPath
  };
}

module.exports = { checkFirewall };
