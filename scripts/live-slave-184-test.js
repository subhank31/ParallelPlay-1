const net = require('net');
const { MasterClient } = require('../link/master-client');

const HOST = process.env.PLAYOUT_SLAVE_HOST || '192.168.127.184';
const PORT = Number(process.env.PLAYOUT_SLAVE_PORT || 47631);
const MEDIA = process.env.PLAYOUT_MEDIA || '/Volumes/1431/PlayoutMedia/Bhajans/Ganapati.mp4';
const IDENTITY = {
  deviceId: 'b222b222-b222-4222-8222-b222b222b222',
  deviceName: 'Parallel Playout — Master 222',
  role: 'master'
};

function record(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

async function main() {
  let failed = 0;
  const check = (n, ok, d) => { if (!record(n, ok, d)) failed += 1; };

  const master = new MasterClient();
  await master.connect({ host: HOST, port: PORT });
  check('connect', master.connectionState === 'connected');

  const hello = await master.request('hello', IDENTITY, 5000).catch((e) => ({ ok: false, error: { message: e.message, code: e.code } }));
  const pairing = hello && hello.ok && hello.payload;
  if (pairing && hello.payload.needsPairing) {
    console.log('Slave needs pairing approval in its UI (Accept).');
  }
  if (pairing && hello.payload.authorized) {
    check('authorized paired master', true);
  }

  let loaded = await master.request('load', { mediaPath: 'Bhajans/Ganapati.mp4', source: 'master' }, 30000);
  if (!loaded.ok) {
    loaded = await master.request('load', { path: MEDIA, source: 'master' }, 30000);
  }
  check('load Ganapati', loaded.ok === true, loaded.ok ? (loaded.payload.path || loaded.payload.mediaPath || MEDIA) : JSON.stringify(loaded.error));

  check('seek', (await master.request('seek', { seconds: 2, source: 'master' })).ok);
  check('play', (await master.request('play', { source: 'master' })).ok);
  await new Promise((r) => setTimeout(r, 800));
  const status = await master.request('getStatus');
  check('playing', status.ok && status.payload.state === 'playing', JSON.stringify(status.payload));
  check('pause', (await master.request('pause', { source: 'master' })).ok);
  check('seek5', (await master.request('seek', { seconds: 5, source: 'master' })).ok);
  check('rate', (await master.request('setRate', { rate: 1.5, source: 'master' })).ok);
  await master.request('setRate', { rate: 1.0, source: 'master' });
  check('stop', (await master.request('stop', { source: 'master' })).ok);

  master.disconnect();
  console.log(failed === 0 ? '\nAll live 184 checks passed.' : `\n${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
