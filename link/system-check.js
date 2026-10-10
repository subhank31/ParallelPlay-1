const { execFile } = require('child_process');
const fs = require('fs');

/** File systems that reach the media over the network. */
const NETWORK_TYPES = new Set(['smbfs', 'afpfs', 'nfs', 'webdav', 'cifs', 'ftp']);

function readMounts() {
  return new Promise((resolve) => {
    execFile('/sbin/mount', [], { timeout: 4000 }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

/** `/sbin/mount` lines look like: //user@host/share on /Volumes/Media (smbfs, nodev, nosuid) */
function parseMounts(text) {
  const mounts = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^(.*) on (.+) \(([^,)]+)/.exec(line);
    if (match) mounts.push({ source: match[1], point: match[2], type: match[3].trim() });
  }
  return mounts;
}

function volumeFor(filePath, mounts) {
  let best = null;
  for (const mount of mounts) {
    const point = mount.point.endsWith('/') ? mount.point : mount.point + '/';
    if ((filePath + '/').startsWith(point) && (!best || mount.point.length > best.point.length)) best = mount;
  }
  return best;
}

function mediaRootItem(root, mountText) {
  const item = { id: 'media', title: 'Media folder' };
  if (!root) {
    return Object.assign(item, { level: 'error', detail: 'Not chosen yet. In Settings, choose the local copy of the playout media on this Mac.' });
  }
  let real = root;
  try {
    real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
  } catch (error) {
    return Object.assign(item, { level: 'error', detail: `${root} is not available. Connect the drive or choose the media folder again in Settings.` });
  }
  const volume = volumeFor(real, parseMounts(mountText));
  if (volume && NETWORK_TYPES.has(volume.type)) {
    return Object.assign(item, {
      level: 'warn',
      detail: `${root} is on a network share (${volume.type}). A slow share can stall loads on air. Use a local copy on this Mac.`
    });
  }
  return Object.assign(item, { level: 'ok', detail: `${root} (on this Mac)` });
}

function firewallItem(role, firewall) {
  const item = { id: 'firewall', title: 'macOS Firewall' };
  if (role !== 'slave') return Object.assign(item, { level: 'ok', detail: 'Not needed on the Master.' });
  if (!firewall || !firewall.enabled) return Object.assign(item, { level: 'ok', detail: 'Firewall is off; the Master can connect.' });
  if (firewall.signed === false) {
    return Object.assign(item, { level: 'error', detail: 'This copy is not code signed, so the Firewall drops the Master. Reinstall Parallel Playout with the installer.' });
  }
  if (firewall.blocked) {
    return Object.assign(item, { level: 'error', detail: 'Parallel Playout is blocked. System Settings › Network › Firewall › Options: set it to Allow incoming connections.' });
  }
  if (!firewall.listed) {
    return Object.assign(item, { level: 'warn', detail: 'Not approved yet. When macOS asks whether Parallel Playout may accept incoming connections, choose Allow.' });
  }
  return Object.assign(item, { level: 'ok', detail: 'Parallel Playout may accept the Master.' });
}

/**
 * What this Mac needs to run live playout unattended, as ok / warn / error items.
 * Inputs are gathered by the caller so this stays testable.
 */
function describeSystem({ role, mediaRoot, mountText, firewall, loginItem, awake, paired }) {
  const items = [
    mediaRootItem(mediaRoot, mountText),
    firewallItem(role, firewall),
    {
      id: 'awake',
      title: 'Keep awake',
      level: awake ? 'ok' : 'warn',
      detail: awake ? 'This Mac and its displays stay awake while Parallel Playout runs.' : 'Could not stop this Mac from sleeping.'
    },
    {
      id: 'login',
      title: 'Start at login',
      level: loginItem === false ? 'warn' : 'ok',
      detail: loginItem === false
        ? 'Parallel Playout will not start by itself after a restart. Add it in System Settings › General › Login Items.'
        : (loginItem === true ? 'Parallel Playout starts by itself after a restart.' : 'Applies to the installed app only.')
    },
    {
      id: 'pairing',
      title: 'Pairing',
      level: paired ? 'ok' : 'warn',
      detail: paired
        ? `Paired with ${paired.deviceName || paired.host}${paired.host ? ` (${paired.host})` : ''}.`
        : (role === 'slave' ? 'Not paired yet. Accept the Master’s connection request when it appears.' : 'Not paired yet. Pair with the Slave on the Connection page.')
    }
  ];
  return { items, ok: items.every((item) => item.level === 'ok') };
}

module.exports = { describeSystem, parseMounts, volumeFor, readMounts, NETWORK_TYPES };
