/**
 * The setup check flags what would hurt unattended live playout: no media
 * folder, media on a network share, a Firewall that drops the Master.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeSystem, parseMounts, volumeFor } = require('../link/system-check');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-syscheck-')));
const mountText = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
  `//studio@nas.local/1431 on ${dir}/share (smbfs, nodev, nosuid, mounted by studio)`
].join('\n');
fs.mkdirSync(path.join(dir, 'share', 'PlayoutMedia'), { recursive: true });
fs.mkdirSync(path.join(dir, 'local', 'PlayoutMedia'), { recursive: true });

const mounts = parseMounts(mountText);
record('mount lines are parsed', mounts.length === 3 && mounts[2].type === 'smbfs' && mounts[2].point === `${dir}/share`,
  JSON.stringify(mounts.map((m) => m.type)));
record('a path maps to its innermost volume', volumeFor(`${dir}/share/PlayoutMedia`, mounts).type === 'smbfs' &&
  volumeFor(`${dir}/sharepoint`, mounts).type !== 'smbfs');

function item(result, id) {
  return result.items.find((entry) => entry.id === id);
}
const base = { role: 'slave', mountText, firewall: { enabled: true, listed: true, blocked: false, signed: true }, loginItem: true, awake: true, paired: { deviceName: 'Master 222', host: '192.168.127.222' } };

const good = describeSystem(Object.assign({}, base, { mediaRoot: path.join(dir, 'local', 'PlayoutMedia') }));
record('a well set up Slave passes every check', good.ok, JSON.stringify(good.items.filter((i) => i.level !== 'ok')));
const share = describeSystem(Object.assign({}, base, { mediaRoot: path.join(dir, 'share', 'PlayoutMedia') }));
record('media on a network share is flagged', item(share, 'media').level === 'warn' && /network share \(smbfs\)/.test(item(share, 'media').detail),
  item(share, 'media').detail);
record('no media folder is an error', item(describeSystem(Object.assign({}, base, { mediaRoot: '' })), 'media').level === 'error');
record('a missing media folder is an error', item(describeSystem(Object.assign({}, base, { mediaRoot: path.join(dir, 'gone') })), 'media').level === 'error');
record('an unsigned Slave copy is an error',
  item(describeSystem(Object.assign({}, base, { mediaRoot: dir, firewall: { enabled: true, signed: false } })), 'firewall').level === 'error');
record('a Firewall-blocked Slave is an error',
  item(describeSystem(Object.assign({}, base, { mediaRoot: dir, firewall: { enabled: true, signed: true, blocked: true } })), 'firewall').level === 'error');
record('a not-yet-approved Slave is a warning',
  item(describeSystem(Object.assign({}, base, { mediaRoot: dir, firewall: { enabled: true, signed: true, listed: false } })), 'firewall').level === 'warn');
record('the Firewall does not matter on the Master',
  item(describeSystem(Object.assign({}, base, { role: 'master', mediaRoot: dir, firewall: null })), 'firewall').level === 'ok');
record('no login item is a warning', item(describeSystem(Object.assign({}, base, { mediaRoot: dir, loginItem: false })), 'login').level === 'warn');
record('not paired is a warning', item(describeSystem(Object.assign({}, base, { mediaRoot: dir, paired: null })), 'pairing').level === 'warn');

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} system check checks passed`);
process.exit(failed.length ? 1 : 0);
