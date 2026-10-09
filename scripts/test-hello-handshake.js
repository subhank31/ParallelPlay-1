const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');
const { installFileLog } = require('../link/file-log');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hello-'));
  const logFile = installFileLog(path.join(dir, 'logs', 'parallel-playout.log'));
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  masterCfg.setRole('master');
  slaveCfg.setRole('slave');
  const master = new LinkController(new RecordingPlayer(), { config: masterCfg, pairRetryDelayMs: 80 });
  const slave = new LinkController(new RecordingPlayer(), { config: slaveCfg, pairRetryDelayMs: 80 });
  await master.setRole('master');
  await slave.setRole('slave');
  const listening = await slave.listen(0);
  const port = listening.snapshot.port;

  slave.on('event', (event) => {
    if (event && event.event === 'pair-request') slave.acceptPairing(event.requestId);
  });

  const pairing = master.requestPairing('127.0.0.1', port);
  const paired = await pairing;
  record('hello + pairRequest completes', paired.ok === true, paired.error);
  const ping = await master.ping();
  record('ping after handshake', ping.ok === true);

  await master.shutdown();
  await slave.shutdown();
  await sleep(100);
  const log = fs.readFileSync(logFile, 'utf8');
  record(
    'log shows peer IP and first bytes on hello',
    /\[link\] connection from 127\.0\.0\.1:\d+/.test(log) &&
      /first bytes from 127\.0\.0\.1:\d+/.test(log) &&
      /"type":"hello"/.test(log) &&
      /master write hello/.test(log),
    log
      .split('\n')
      .filter((line) => /connection from|first bytes|master write hello|slave_hello|ended/.test(line))
      .slice(0, 8)
      .join(' | ')
  );
  record(
    'connection stays open through hello (not instant network error)',
    !/ended with no application data after [0-9] ms \(network error\)/.test(log),
    'no sub-10ms empty closes'
  );

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} hello handshake checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
