const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveHelperPath } = require('../player-session');
const { measureSample, slaveTimeForMasterTime } = require('../link/clock-sync');

const root = path.join(__dirname, '..');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(js|swift|html|json)$/.test(entry.name) && entry.name !== 'package-lock.json') files.push(full);
  }
}

function main() {
  const binary = resolveHelperPath();
  let info = '';
  try {
    info = execFileSync('lipo', ['-info', binary], { encoding: 'utf8' });
  } catch (error) {
    info = error.stdout || error.message;
  }
  record(
    'player binary contains Intel and Apple Silicon',
    info.includes('x86_64') && info.includes('arm64'),
    info.trim()
  );

  const clockSource = fs.readFileSync(path.join(root, 'link', 'clock-sync.js'), 'utf8');
  const sample = measureSample({ t0: 0, t1: 100, t2: 110, t3: 20 });
  record(
    'sync uses each Mac’s own millisecond clock',
    clockSource.includes('process.hrtime.bigint()') &&
      clockSource.includes('/ 1e6') &&
      !/cpufrequency|hw\.cpu|os\.cpus/.test(clockSource) &&
      sample.rttMs === 10 &&
      sample.offsetMs === 95 &&
      slaveTimeForMasterTime(1000, -40) === 960,
    `offset=${sample.offsetMs} rtt=${sample.rttMs}`
  );

  const files = [];
  for (const name of ['main.js', 'preload.js', 'index.html', 'player-session.js', 'player-ipc.js', 'link-ipc.js', 'dialog-filters.js', 'playlist-ui.js', 'package.json', 'link', 'native']) {
    const full = path.join(root, name);
    if (fs.statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  const forbidden = [
    /Mac ?mini/i,
    /Mac16,/,
    /Mac Studio/,
    /192\.168\.127\.(185|222)/,
    /process\.arch\s*===?\s*['"]arm64['"]/,
    /arch(?:itecture)?\s*===?\s*['"]arm64['"]/
  ];
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) hits.push(`${path.relative(root, file)} ${pattern}`);
    }
  }
  record('app source has no machine-specific assumptions', hits.length === 0, hits.join(' | '));

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const targets = packageJson.build.mac.target.map((target) => target.arch.join(','));
  record(
    'packaged app is built for both Mac architectures',
    targets.every((arch) => arch === 'universal') &&
      packageJson.scripts['build:player'].includes('--arch arm64') &&
      packageJson.scripts['build:player'].includes('--arch x86_64'),
    targets.join(' ')
  );

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} hardware checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
