const { ConfigStore } = require('../link/config-store');
const { LinkController } = require('../link/link-controller');
const { RecordingPlayer } = require('../link/recording-player');
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOST = process.env.PLAYOUT_SLAVE_HOST || '192.168.127.184';
const PORT = Number(process.env.PLAYOUT_SLAVE_PORT || 47631);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-diag-'));
  const cfg = new ConfigStore(path.join(dir, 'master.json'));
  cfg.setRole('master');
  const link = new LinkController(new RecordingPlayer(), { config: cfg, pairRetryDelayMs: 100 });
  await link.setRole('master');
  const attempt = link.requestPairing(HOST, PORT);
  await new Promise((r) => setTimeout(r, 2500));
  const snap = link.snapshot();
  console.log('\n=== Connection trace (Master) ===');
  console.log(JSON.stringify(snap.connectionTrace, null, 2));
  console.log('\nlastPairError:', snap.lastPairError);
  console.log('pairingState:', snap.pairingState);
  console.log('slaveUnavailable:', snap.slaveUnavailable);
  await link.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await Promise.race([attempt, new Promise((r) => setTimeout(r, 500))]);
  } catch (e) {
    /* retry loop */
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
