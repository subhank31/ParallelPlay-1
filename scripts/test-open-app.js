const fs = require('fs');
const os = require('os');
const path = require('path');
const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');
const { MasterClient } = require('../link/master-client');
const { LinkController } = require('../link/link-controller');
const { ConfigStore } = require('../link/config-store');
const { execute } = require('../link/player-bridge');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const player = new RecordingPlayer();
  const missing = await execute(player, { type: 'openApp', payload: {}, source: 'master' }, {});
  record(
    'openApp without a running app fails clearly',
    missing.ok === false && missing.error && missing.error.code === 'NOT_RUNNING' && player.commands.length === 0,
    missing.error && missing.error.message
  );

  let opened = 0;
  const focused = await execute(player, { type: 'openApp', payload: {}, source: 'master' }, {
    openApp: async () => {
      opened += 1;
      return { ok: true, alreadyRunning: true };
    }
  });
  record(
    'openApp focuses a running app and does not reload media',
    focused.ok === true && focused.payload.alreadyRunning === true && opened === 1 && player.commands.length === 0,
    JSON.stringify(focused.payload)
  );

  const locked = new RecordingPlayer();
  const slave = new SlaveServer({
    player: locked,
    host: '127.0.0.1',
    enforcePairing: true,
    openApp: async () => ({ ok: true, alreadyRunning: false })
  });
  const master = new MasterClient();
  const listening = await slave.start(0);
  await master.connect({ host: '127.0.0.1', port: listening.port });
  const denied = await master.request('openApp', {});
  record(
    'unpaired master cannot open the slave app',
    denied.ok === false && denied.error && denied.error.code === 'NOT_AUTHORIZED' && locked.commands.length === 0,
    denied.error && denied.error.code
  );
  master.disconnect();
  await slave.stop();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-open-'));
  const masterCfg = new ConfigStore(path.join(dir, 'master.json'));
  masterCfg.setRole('master');
  const link = new LinkController(new RecordingPlayer(), { config: masterCfg });
  link.autoReconnect = false;
  const unpaired = await link.openSlaveApp();
  record(
    'master without a paired slave is refused',
    unpaired.ok === false && unpaired.error && unpaired.error.code === 'NOT_PAIRED',
    unpaired.error && unpaired.error.message
  );

  masterCfg.setPaired({
    deviceId: 'slave-slave-slave-slave',
    deviceName: 'Missing Slave',
    role: 'slave',
    host: '127.0.0.1',
    port: 1
  });
  const offline = await link.openSlaveApp();
  record(
    'missing slave app reports that it is not running',
    offline.ok === false && offline.error && offline.error.code === 'NOT_RUNNING',
    offline.error && offline.error.message
  );

  const trustedPlayer = new RecordingPlayer();
  let launches = 0;
  const trusted = new SlaveServer({
    player: trustedPlayer,
    host: '127.0.0.1',
    openApp: async () => {
      launches += 1;
      return { ok: true, alreadyRunning: true };
    }
  });
  const trustedPort = await trusted.start(0);
  const trustedMaster = new MasterClient();
  await trustedMaster.connect({ host: '127.0.0.1', port: trustedPort.port });
  const openedRemote = await trustedMaster.request('openApp', { source: 'master' });
  record(
    'paired connection opens the running slave app',
    openedRemote.ok === true && openedRemote.payload.opened === true && launches === 1 && trustedPlayer.commands.length === 0,
    JSON.stringify(openedRemote.payload)
  );
  trustedMaster.disconnect();
  await trusted.stop();
  link.client.disconnect();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} open-app checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
