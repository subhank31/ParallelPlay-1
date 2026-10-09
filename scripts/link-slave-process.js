const { SlaveServer } = require('../link/slave-server');
const { RecordingPlayer } = require('../link/recording-player');

const server = new SlaveServer({
  player: new RecordingPlayer(),
  host: '127.0.0.1'
});

server.start(0).then(({ port }) => {
  process.stdout.write(`LISTENING ${port}\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
