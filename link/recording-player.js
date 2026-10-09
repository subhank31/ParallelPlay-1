class RecordingPlayer {
  constructor() {
    this.commands = [];
    this.state = { status: 'idle', position: 0, duration: 0, rate: 1, path: null };
  }

  send(type, fields = {}) {
    this.commands.push({ type, fields: Object.assign({}, fields) });
    if (type === 'load') {
      this.state = {
        status: 'ready',
        position: 0,
        duration: 12,
        rate: this.state.rate,
        path: fields.path
      };
    } else if (type === 'play') {
      this.state.status = 'playing';
    } else if (type === 'pause') {
      this.state.status = 'paused';
    } else if (type === 'stop') {
      this.state.status = 'stopped';
      this.state.position = 0;
    } else if (type === 'seek') {
      this.state.position = fields.seconds;
    } else if (type === 'setRate') {
      this.state.rate = fields.rate;
    } else if (type === 'fullscreen') {
      this.state.fullscreen = fields.enabled !== false;
    }
    return Promise.resolve({ ok: true, state: Object.assign({}, this.state) });
  }
}

module.exports = { RecordingPlayer };
