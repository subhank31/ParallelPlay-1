/**
 * electron-builder afterSign hook.
 *
 * Fails the build when the packaged app has no full code signature. A bundle
 * with only the linker's signature on the executable has no designated
 * requirement, and macOS Application Firewall then drops every inbound
 * connection to the Slave, even when the app is set to Allow.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function verifySignature(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = fs.readdirSync(context.appOutDir).find((name) => name.endsWith('.app'));
  if (!app) throw new Error(`verify-signature: no .app in ${context.appOutDir}`);
  const appPath = path.join(context.appOutDir, app);
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`verify-signature: ${appPath} is not fully signed: ${String(error.stderr || error.message).trim()}`);
  }
  const requirement = execFileSync('/usr/bin/codesign', ['-d', '-r-', appPath], { stdio: 'pipe' }).toString();
  if (!/designated =>/.test(requirement)) {
    throw new Error(`verify-signature: ${appPath} has no designated requirement`);
  }
  console.log(`  • verify-signature  ${appPath}: ${requirement.trim().split('\n').pop()}`);
};
