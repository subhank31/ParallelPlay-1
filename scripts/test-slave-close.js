const fs = require('fs');
const net = require('net');
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
async function waitUntil(predicate, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(30);
  }
  return false;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-close-'));
  const logFile = installFileLog(path.join(dir, 'logs', 'parallel-playout.log'));
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  masterCfg.setRole('master');
  const masterId = masterCfg.data.deviceId;
  const master = new LinkController(new RecordingPlayer(), { config: masterCfg, pairRetryDelayMs: 50 });
  await master.setRole('master');

  // A listener that accepts and closes without a byte, the way a blocked app looks from outside.
  const silent = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const silentPort = silent.address().port;
  const silentPairing = master.requestPairing('127.0.0.1', silentPort);
  const sawSilent = await waitUntil(() =>
    /failure before hello JSON response|closed the connection before answering/.test(master.snapshot().lastPairError || '')
  );
  const snap = master.snapshot();
  record(
    'silent close reports the Slave closed without answering and keeps retrying',
    sawSilent && snap.pairingState === 'requesting' && snap.paired === false && snap.slaveUnavailable === false,
    snap.lastPairError
  );
  await master.unpair().catch(() => {});
  await Promise.race([silentPairing, sleep(500)]);
  silent.close();

  // A real Slave whose connection setup throws.
  const slaveCfg = new ConfigStore(path.join(dir, 'slave.json'));
  slaveCfg.setRole('slave');
  const slaveId = slaveCfg.data.deviceId;
  const slave = new LinkController(new RecordingPlayer(), { config: slaveCfg, pairRetryDelayMs: 50 });
  await slave.setRole('slave');
  const listening = await slave.listen(0);
  const port = listening.snapshot.port;
  const server = slave.server;
  const realAccept = server._acceptConnection.bind(server);
  let failures = 1;
  server._acceptConnection = (socket) => {
    if (failures > 0) {
      failures -= 1;
      server.sockets.add(socket);
      throw new Error('simulated setup failure');
    }
    return realAccept(socket);
  };
  let requests = 0;
  slave.on('event', (event) => {
    if (event && event.event === 'pair-request') {
      requests += 1;
      slave.acceptPairing(event.requestId);
    }
  });
  const pairing = master.requestPairing('127.0.0.1', port);
  const sawReason = await waitUntil(() => /The Slave refused the connection: The Slave could not open the connection: simulated setup failure/.test(master.snapshot().lastPairError || '') || master.snapshot().paired === true);
  const firstError = master.snapshot().lastPairError;
  const paired = await pairing;
  record(
    'a Slave-side failure reaches the Master as the real reason',
    sawReason && /simulated setup failure/.test(firstError || '') === true || /simulated/.test(String(firstError)),
    firstError
  );
  record(
    'the Slave keeps listening and the retry pairs after accept',
    paired.ok === true && slave.listening === true && master.snapshot().connection === 'connected' && requests === 1,
    `ok=${paired.ok} requests=${requests} listening=${slave.listening}`
  );
  const ping = await master.ping();
  record('ping works after the failed attempt', ping.ok === true);
  record(
    'identities unchanged',
    masterCfg.data.deviceId === masterId && slaveCfg.data.deviceId === slaveId
  );

  await master.shutdown();
  await sleep(150);
  await slave.shutdown();
  const log = fs.readFileSync(logFile, 'utf8');
  record(
    'log file records each connection and why it ended',
    /\[link\] connection from 127\.0\.0\.1/.test(log) &&
      /connection failed: simulated setup failure/.test(log) &&
      (/ended after \d+ ms \(failed: simulated setup failure\)/.test(log) ||
        /ended with no application data after \d+ ms \(failed: simulated setup failure\)/.test(log)) &&
      /ended after \d+ ms \((closed by the Master|Slave listener stopped)\)/.test(log),
    log.split('\n').filter((line) => /\[link\] (connection|could not)/.test(line)).map((line) => line.slice(25)).join(' | ')
  );
  if (process.env.SHOW_LOG) console.log(log);
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} slave close checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
