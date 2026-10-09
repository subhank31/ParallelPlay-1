const net = require('net');
const readline = require('readline');
const { EventEmitter } = require('events');
const { encode, endpointError } = require('./protocol');
const { monotonicNow, sharedNow } = require('./clock-sync');

class MasterClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clock = options.clock || { monotonicNow, sharedNow };
    this.trace = options.trace || null;
    this.socket = null;
    this.lines = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connectionState = 'disconnected';
    this.host = null;
    this.port = null;
    this.localAddress = null;
  }

  snapshot() {
    return {
      connection: this.connectionState,
      host: this.host,
      port: this.port
    };
  }

  connect({ host, port }) {
    const problem = endpointError(host, port);
    if (problem) return Promise.reject(Object.assign(new Error(problem), { code: 'INVALID_ENDPOINT' }));
    const previous = this.socket;
    this.socket = null;
    if (previous && !previous.destroyed) {
      previous._retired = true;
      previous.destroy();
    }
    return new Promise((resolve, reject) => {
      this.connectionState = 'connecting';
      this.host = host;
      this.port = Number(port);
      this.emit('state', this.snapshot());
      if (this.trace) this.trace.stage('master_tcp_connecting', `${host}:${this.port}`);
      const socket = net.connect({ host, port: this.port });
      socket.bytesReceived = 0;
      socket.on('data', (chunk) => {
        socket.bytesReceived += chunk.length;
      });
      this.socket = socket;
      const lines = readline.createInterface({ input: socket });
      lines.on('error', (error) => {
        const code = (error && error.code) || (error && error.message) || String(error);
        console.error(`[link] master read error from ${host}:${this.port}: ${code}`);
      });
      this.lines = lines;
      let settled = false;
      let connectTimer = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.connectionState = 'disconnected';
        reject(error);
      };
      connectTimer = setTimeout(() => {
        if (settled || socket._retired) return;
        socket.destroy();
        fail(Object.assign(new Error('Slave did not accept the connection.'), { code: 'CONNECT_TIMEOUT' }));
      }, 8000);
      socket.once('connect', () => {
        if (settled || socket._retired) return;
        clearTimeout(connectTimer);
        settled = true;
        this.connectionState = 'connected';
        this.localAddress = socket.localAddress
          ? String(socket.localAddress).replace(/^::ffff:/, '')
          : null;
        socket.setKeepAlive(true, 1000);
        socket.setNoDelay(true);
        const peer = socket.remoteAddress
          ? `${String(socket.remoteAddress).replace(/^::ffff:/, '')}:${socket.remotePort != null ? socket.remotePort : '?'}`
          : 'unknown:?';
        console.error(
          `[link] master tcp connected to ${host}:${this.port} (socket peer ${peer}, local ${this.localAddress || '?'})`
        );
        if (this.trace) {
          this.trace.stage(
            'master_tcp_connected',
            `${host}:${this.port}${this.localAddress ? ` (from ${this.localAddress})` : ''}`
          );
        }
        this.emit('state', this.snapshot());
        resolve(this.snapshot());
      });
      socket.on('error', (error) => {
        if (!settled && !socket._retired) {
          if (this.trace) this.trace.fail('master_tcp_error', error.code || error.message);
          fail(error);
        }
      });
      socket.on('close', () => {
        clearTimeout(connectTimer);
        try {
          lines.close();
        } catch (error) {
          // The interface is already closed when the socket fails first.
        }
        const closedBy = (fallback) => {
          const bytes = socket.bytesReceived || 0;
          if (socket.slaveError) {
            return Object.assign(
              new Error(`The Slave refused the connection: ${socket.slaveError.message || socket.slaveError.code}`),
              { code: socket.slaveError.code || 'SLAVE_ERROR', bytesReceived: bytes }
            );
          }
          return Object.assign(new Error(fallback), { code: 'DISCONNECTED', bytesReceived: bytes });
        };
        if (this.trace && !socket._retired) {
          const bytes = socket.bytesReceived || 0;
          this.trace.fail('master_tcp_closed', `${bytes} byte(s) received from Slave`);
        }
        if (socket._retired) {
          if (!settled) fail(closedBy('Slave connection closed.'));
          return;
        }
        if (this.socket === socket) this.socket = null;
        this._failPending(closedBy('Slave disconnected.'));
        this.connectionState = 'disconnected';
        if (!settled) fail(closedBy('Slave connection closed.'));
        this.emit('disconnected');
        this.emit('state', this.snapshot());
      });
      lines.on('line', (line) => this._onLine(line, socket));
    });
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connectionState = 'disconnected';
    this._failPending(Object.assign(new Error('Slave disconnected.'), { code: 'DISCONNECTED' }));
    if (socket && !socket.destroyed) {
      socket._retired = true;
      socket.destroy();
    }
  }

  request(type, payload = {}, timeoutMs = 8000) {
    if (this.connectionState !== 'connected' || !this.socket || this.socket.destroyed) {
      return Promise.reject(Object.assign(new Error('Slave is not connected.'), { code: 'NOT_CONNECTED' }));
    }
    const requestId = String(this.nextId++);
    const body = payload && typeof payload === 'object' ? Object.assign({}, payload) : {};
    const source = body.source === 'master' || body.source === 'local' || body.source === 'slave'
      ? body.source
      : undefined;
    if (source) delete body.source;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`Slave did not answer ${type}.`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, type });
      const message = { type, requestId, payload: body };
      if (source) message.source = source;
      try {
        const encoded = encode(message);
        if (type === 'hello' || type === 'pairRequest') {
          console.error(
            `[link] master write ${type} requestId=${requestId} ${encoded.length} bytes to ${this.host}:${this.port}`
          );
        }
        if (this.trace && type === 'hello') this.trace.stage('master_send_hello');
        if (this.trace && type === 'pairRequest') this.trace.stage('master_send_pair_request');
        this.socket.write(encoded, (error) => {
          if (!error) return;
          console.error(
            `[link] master write failed ${type} to ${this.host}:${this.port}: ${error.code || error.message}`
          );
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  _onLine(line, socket) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error(
        `[link] master received non-JSON line from Slave (${line.length} chars): ${line.slice(0, 120)}`
      );
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'execution' && message.payload && typeof message.payload === 'object') {
      this.emit('execution', message.payload);
      return;
    }
    if (message.type === 'getSession' && typeof message.requestId === 'string') {
      this.emit('request', message);
      return;
    }
    if (message.type === 'response' && message.requestId == null && message.ok === false &&
      message.error && typeof message.error === 'object' && socket) {
      socket.slaveError = message.error;
      return;
    }
    if (message.type !== 'response' || !this.pending.has(message.requestId)) return;
    const pendingType = this.pending.get(message.requestId).type;
    if (this.trace && pendingType === 'hello') this.trace.stage('master_hello_response', message.ok ? 'ok' : 'error');
    if (this.trace && pendingType === 'pairRequest') {
      this.trace.stage('master_pair_response', message.ok ? 'accepted' : 'rejected');
    }
    const receivedAt = this.clock.monotonicNow();
    const receivedWall = typeof this.clock.sharedNow === 'function' ? this.clock.sharedNow() : sharedNow();
    const pending = this.pending.get(message.requestId);
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    message.receivedAt = receivedAt;
    message.receivedWall = receivedWall;
    pending.resolve(message);
  }

  _failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { MasterClient };
