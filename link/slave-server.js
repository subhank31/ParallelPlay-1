const net = require('net');
const readline = require('readline');
const { EventEmitter } = require('events');
const {
  encode,
  failure,
  success,
  parseRequest,
  LINK_COMMANDS,
  PAIRING_COMMANDS,
  AUTHORIZED_COMMANDS,
  identityPayloadError
} = require('./protocol');
const { execute } = require('./player-bridge');
const { monotonicNow, sharedNow, timeSyncPayloadError } = require('./clock-sync');
const { CommandScheduler } = require('./scheduled-command');
const { peerEndpoint, refreshPeer, previewBytes, localEndpoint, socketDiag } = require('./peer');

/** Master commands that must not wait behind a slow load. */
const PREEMPTING_COMMANDS = new Set(['stop', 'pause']);

/**
 * Slave TCP server.
 *
 * When `enforcePairing` is false (unit tests / open mode), any connected
 * master may send playback commands — preserves existing test-link behavior.
 *
 * When `enforcePairing` is true:
 *   - unknown master may only send hello / pairRequest
 *   - paired master (hello/deviceId match) may control playback
 *   - pending pairRequest waits for UI Accept/Reject
 */
class SlaveServer extends EventEmitter {
  constructor({
    player, host = '0.0.0.0', clock, scheduler, config, enforcePairing = false, openApp = null, trace = null,
    describePlayout = null, silenceMs = 0
  } = {}) {
    super();
    this.player = player;
    this.host = host;
    this.config = config || null;
    this.enforcePairing = enforcePairing === true;
    this.clock = clock || { monotonicNow };
    this.scheduler = scheduler || new CommandScheduler({ clock: this.clock, player });
    this.scheduler.onExecuted = (execution) => {
      this.lastExecution = execution;
      this._write(this.client, { type: 'execution', payload: execution });
      this.emit('execution', execution);
    };
    this.server = null;
    this.sockets = new Set();
    this.client = null;
    this.port = null;
    this.lastExecution = null;
    this.queue = Promise.resolve();
    this.priorityQueue = Promise.resolve();
    this.transportEpoch = 0;
    this.authorizedDeviceId = null;
    this.openApp = openApp;
    this.trace = trace;
    this.pendingPair = null;
    this.remoteAddress = null;
    this.outbound = new Map();
    this.nextRequestId = 1;
    // Read-only view of what this Slave is playing, for a Master that rejoins.
    this.describePlayout = typeof describePlayout === 'function' ? describePlayout : null;
    // A Master that sends heartbeats and then goes silent this long is gone,
    // even if its Mac lost power and TCP never closed.
    this.silenceMs = silenceMs > 0 ? silenceMs : 0;
    this.silenceTimer = null;
  }

  mediaRoot() {
    return (this.config && this.config.data && this.config.data.mediaRoot) || '';
  }

  start(port = 0) {
    if (this.server) return Promise.resolve({ port: this.port, host: this.host });
    return new Promise((resolve, reject) => {
      const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: false }, (socket) =>
        this._onConnection(socket)
      );
      const onListenError = (error) => {
        server.close();
        reject(error);
      };
      server.once('error', onListenError);
      server.listen(port, this.host, () => {
        server.removeListener('error', onListenError);
        server.on('error', (error) => {
          if (this.listenerCount('error') === 0) return;
          this.emit('error', error);
        });
        const address = server.address();
        if (!address) {
          server.close();
          reject(new Error('Slave listener did not start.'));
          return;
        }
        this.server = server;
        this.port = address.port;
        this._watchSilence();
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  _watchSilence() {
    if (!this.silenceMs || this.silenceTimer) return;
    this.silenceTimer = setInterval(() => {
      const socket = this.client;
      if (!socket || socket.destroyed || !socket.heartbeatSeen || !this._isAuthorized(socket)) return;
      const quietMs = Date.now() - socket.lastLineAt;
      if (quietMs <= this.silenceMs) return;
      console.error(`[link] no word from the Master at ${peerEndpoint(socket)} for ${quietMs} ms; treating it as gone`);
      socket.closeReason = `Master silent for ${quietMs} ms`;
      socket.destroy();
    }, 1000);
    if (typeof this.silenceTimer.unref === 'function') this.silenceTimer.unref();
  }

  stop() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.scheduler) this.scheduler.cancel();
    this._clearPendingPair('server_stopped');
    for (const socket of this.sockets) {
      if (!socket.destroyed) {
        socket.closeReason = 'Slave listener stopped';
        socket.destroy();
      }
    }
    this.sockets.clear();
    this.client = null;
    this.authorizedDeviceId = null;
    this.remoteAddress = null;
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * UI Accept for a pending pairRequest.
   */
  acceptPairing(requestId) {
    if (!this.pendingPair || this.pendingPair.requestId !== requestId) {
      return { ok: false, error: 'No matching connection request.' };
    }
    const pending = this.pendingPair;
    this.pendingPair = null;
    const peer = {
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      role: 'master',
      host: pending.host || this.remoteAddress || 'unknown',
      port: pending.port || 47631,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    if (this.config) this.config.setPaired(peer);
    this._authorize(pending.socket, peer.deviceId);
    if (pending.socket && !pending.socket.destroyed) {
      this._write(pending.socket, success(requestId, {
        accepted: true,
        deviceId: this.config ? this.config.data.deviceId : null,
        deviceName: this.config ? this.config.data.deviceName : 'Slave',
        role: 'slave'
      }));
    }
    this.emit('paired', peer);
    this.emit('state');
    return { ok: true, paired: peer };
  }

  /**
   * UI Reject for a pending pairRequest.
   */
  rejectPairing(requestId, reason) {
    if (!this.pendingPair || this.pendingPair.requestId !== requestId) {
      return { ok: false, error: 'No matching connection request.' };
    }
    const pending = this.pendingPair;
    this.pendingPair = null;
    if (pending.socket && !pending.socket.destroyed) {
      this._write(
        pending.socket,
        failure(requestId, 'PAIR_REJECTED', reason || 'Connection request rejected.')
      );
      pending.socket.closeReason = 'request rejected on the Slave';
      pending.socket.destroy();
    }
    this.emit('pair-rejected', { requestId, deviceId: pending.deviceId });
    this.emit('state');
    return { ok: true };
  }

  clearAuthorization() {
    if (this.client) this.client.authorizedDeviceId = null;
    this.authorizedDeviceId = null;
    this._clearPendingPair('cleared');
  }

  _clearPendingPair(reason) {
    if (!this.pendingPair) return;
    const pending = this.pendingPair;
    this.pendingPair = null;
    if (pending.socket && !pending.socket.destroyed && reason !== 'accepted') {
      this._write(
        pending.socket,
        failure(pending.requestId, 'PAIR_CANCELLED', 'Connection request cancelled.')
      );
    }
  }

  _onConnection(socket) {
    const openedAt = Date.now();
    let peerLabel = peerEndpoint(socket);
    refreshPeer(socket);
    console.error(
      `[link] connection from ${peerLabel} on ${localEndpoint(socket)} (${socketDiag(socket)})`
    );
    if (this.trace) this.trace.stage('slave_tcp_accepted', peerLabel);
    setImmediate(() => {
      const resolved = refreshPeer(socket);
      if (resolved !== peerLabel && !resolved.startsWith('unknown')) {
        peerLabel = resolved;
        console.error(`[link] connection peer resolved: ${peerLabel}`);
      }
    });
    socket.on('error', (error) => {
      const code = (error && error.code) || (error && error.message) || String(error);
      const syscall = (error && error.syscall) || 'unknown-syscall';
      if (!socket.closeReason) socket.closeReason = `socket error: ${syscall} ${code}`;
      console.error(
        `[link] connection error from ${peerEndpoint(socket)}: syscall=${syscall} code=${code} (${socketDiag(socket)})`
      );
    });
    socket.on('end', () => {
      if (!socket.closeReason) socket.closeReason = 'closed by the Master';
    });
    socket.on('close', (hadError) => {
      this.sockets.delete(socket);
      const reason = socket.closeReason || (hadError ? 'network error' : 'closed');
      const peer = peerEndpoint(socket);
      if (!socket._loggedFirstBytes) {
        console.error(
          `[link] connection from ${peer} ended with no application data after ${Date.now() - openedAt} ms (${reason})`
        );
      } else {
        console.error(`[link] connection from ${peer} ended after ${Date.now() - openedAt} ms (${reason})`);
      }
    });
    try {
      this._acceptConnection(socket);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`[link] connection failed: ${message}`);
      this.emit('connection-error', error);
      if (!socket.destroyed) {
        socket.closeReason = `failed: ${message}`;
        socket.resume();
        try {
          socket.end(encode(failure(null, 'SLAVE_ERROR', `The Slave could not open the connection: ${message}`)));
        } catch (writeError) {
          socket.destroy();
        }
        setTimeout(() => { if (!socket.destroyed) socket.destroy(); }, 1000).unref();
      }
    }
  }

  _acceptConnection(socket) {
    this.sockets.add(socket);
    socket.authorizedDeviceId = null;
    refreshPeer(socket);
    try {
      socket.setKeepAlive(true, 1000);
    } catch (error) {
      console.error(
        `[link] setKeepAlive failed on ${peerEndpoint(socket)}: ${error.code || error.message} (${socketDiag(socket)})`
      );
    }
    try {
      socket.setNoDelay(true);
    } catch (error) {
      console.error(
        `[link] setNoDelay failed on ${peerEndpoint(socket)}: ${error.code || error.message} (${socketDiag(socket)})`
      );
    }
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', (error) => {
      const code = (error && error.code) || (error && error.message) || String(error);
      if (!socket.closeReason) socket.closeReason = `read error: ${code}`;
      console.error(`[link] read error from ${peerEndpoint(socket)}: ${code} (${socketDiag(socket)})`);
    });
    lines.on('line', (line) => {
      try {
        if (!socket._loggedFirstBytes) {
          socket._loggedFirstBytes = true;
          console.error(
            `[link] first bytes from ${peerEndpoint(socket)} (${line.length}): ${previewBytes(Buffer.from(String(line)))}`
          );
        }
        if (!socket.traceFirstLine) {
          socket.traceFirstLine = true;
          if (this.trace) this.trace.stage('slave_first_line', `${line.length} chars`);
        }
        socket.lastLineAt = Date.now();
        const answered = this._takeResponse(line, socket);
        if (answered) return;
        const receivedAt = this.clock.monotonicNow();
        const receivedWall = typeof this.clock.sharedNow === 'function' ? this.clock.sharedNow() : sharedNow();
        const parsed = parseRequest(line);
        if (!parsed.ok) {
          console.error(
            `[link] parse error from ${peerEndpoint(socket)}: ${parsed.code} — ${previewBytes(Buffer.from(String(line).slice(0, 200)))}`
          );
        }
        // Heartbeats and playout reads never wait behind a slow load.
        if (parsed.ok && parsed.message.type === 'heartbeat') {
          if (socket === this.client) socket.heartbeatSeen = true;
          this._write(socket, success(parsed.message.requestId, { alive: true }));
          return;
        }
        if (parsed.ok && parsed.message.type === 'getPlayout') {
          this._respondPlayout(socket, parsed.message);
          return;
        }
        if (parsed.ok && parsed.message.type === 'timeSync') {
          if (socket !== this.client || !this._isAuthorized(socket)) {
            this._write(
              socket,
              failure(parsed.message.requestId, 'NOT_AUTHORIZED', 'Pair this Master before syncing the clock.')
            );
            return;
          }
          this._respondTimeSync(socket, parsed.message, receivedAt, receivedWall);
          return;
        }
        // Stop and Pause from the active Master do not wait behind a slow
        // load. They start a new transport epoch; play/seek/stop/pause that
        // arrived earlier are skipped instead of running after them.
        const preempts = parsed.ok && PREEMPTING_COMMANDS.has(parsed.message.type) &&
          socket === this.client && this._isAuthorized(socket);
        if (preempts) {
          this.transportEpoch += 1;
          if (this.scheduler) this.scheduler.cancel();
        }
        const epoch = this.transportEpoch;
        const run = () => this._handleParsed(socket, parsed, epoch);
        const onFailure = (error) => {
          const message = error && error.message ? error.message : String(error);
          console.error(`[link] command failed from ${peerEndpoint(socket)}: ${message}`);
          this.emit('connection-error', error);
        };
        if (preempts) {
          this.priorityQueue = this.priorityQueue.then(run).catch(onFailure);
        } else {
          this.queue = this.queue.then(run).catch(onFailure);
        }
      } catch (error) {
        console.error(`[link] could not handle a message from ${socket.remoteHost || 'unknown'}: ${error && error.message ? error.message : error}`);
        this.emit('connection-error', error);
      }
    });
    socket.on('close', () => {
      try {
        lines.close();
      } catch (error) {
        // The interface is already closed when the socket fails first.
      }
      this.sockets.delete(socket);
      if (this.pendingPair && this.pendingPair.socket === socket) {
        this.pendingPair = null;
        this.emit('pair-cancelled');
      }
      if (this.client !== socket) return;
      this.client = null;
      this.authorizedDeviceId = null;
      this.emit('master-disconnected');
      this.emit('state');
      for (const pending of this.outbound.values()) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error('Master disconnected.'), { code: 'DISCONNECTED' }));
      }
      this.outbound.clear();
      const waiting = Array.from(this.sockets).reverse().find((other) => !other.destroyed && !other.closeReason);
      if (waiting) this._adoptClient(waiting);
    });
    const replaceClient =
      !this.client ||
      this.client.destroyed ||
      this.client === socket ||
      !this._isAuthorized(this.client);
    if (this.client !== socket && replaceClient) {
      this._adoptClient(socket);
    } else if (this.client !== socket) {
      console.error(
        `[link] extra connection from ${peerEndpoint(socket)} ignored (authorized master already connected)`
      );
    }
    try {
      socket.resume();
    } catch (error) {
      console.error(
        `[link] socket.resume failed on ${peerEndpoint(socket)}: ${error.code || error.message} (${socketDiag(socket)})`
      );
    }
  }

  _adoptClient(socket) {
    const previous = this.client;
    this.client = socket;
    this.remoteAddress = socket.remoteHost || null;
    if (typeof socket.authorizedDeviceId === 'string') this.authorizedDeviceId = socket.authorizedDeviceId;
    if (previous && previous !== socket && !previous.destroyed) {
      previous.closeReason = 'replaced by a newer connection';
      previous.destroy();
    }
    try {
      this.emit('master-connected', { remoteAddress: this.remoteAddress });
      this.emit('state');
    } catch (error) {
      console.error(`[link] could not show the connection: ${error && error.message ? error.message : error}`);
    }
  }

  _authorize(socket, deviceId) {
    if (socket) socket.authorizedDeviceId = deviceId;
    const paired = this.config ? this.config.getPaired() : null;
    if (socket && paired && paired.deviceId === deviceId && socket !== this.client) {
      this._adoptClient(socket);
    }
    if (socket === this.client) this.authorizedDeviceId = deviceId;
  }

  _isAuthorized(socket) {
    const current = socket || this.client;
    if (!current || current !== this.client) return false;
    if (!this.enforcePairing) return true;
    return typeof current.authorizedDeviceId === 'string' && current.authorizedDeviceId.length > 0;
  }

  _respondPlayout(socket, message) {
    if (socket !== this.client || !this._isAuthorized(socket)) {
      this._write(socket, failure(message.requestId, 'NOT_AUTHORIZED', 'This Master is not paired with this Slave.'));
      return;
    }
    if (!this.describePlayout) {
      this._write(socket, failure(message.requestId, 'UNKNOWN_COMMAND', 'This Slave cannot describe its playout.'));
      return;
    }
    Promise.resolve()
      .then(() => this.describePlayout())
      .then((result) => {
        if (result && result.ok) this._write(socket, success(message.requestId, result.payload));
        else {
          const error = (result && result.error) || { code: 'STATE_UNAVAILABLE', message: 'The Slave could not read its player.' };
          this._write(socket, failure(message.requestId, error.code, error.message));
        }
      })
      .catch((error) => {
        this._write(socket, failure(message.requestId, 'STATE_UNAVAILABLE', error.message));
      });
  }

  _respondTimeSync(socket, message, receivedAt, receivedWall) {
    const problem = timeSyncPayloadError(message.payload);
    if (problem) {
      this._write(socket, failure(message.requestId, problem.code, problem.message));
      return;
    }
    const readWall = typeof this.clock.sharedNow === 'function' ? this.clock.sharedNow : sharedNow;
    const sentAt = this.clock.monotonicNow();
    const sentWall = readWall();
    const arrivedWall = Number.isFinite(receivedWall) ? receivedWall : sentWall;
    this._write(socket, success(message.requestId, {
      t0: message.payload.t0,
      t1: receivedAt,
      t2: sentAt,
      w1: arrivedWall,
      w2: sentWall
    }));
  }

  _handleScheduledPlay(socket, message) {
    const result = this.scheduler.accept(message.payload);
    if (!result.ok) {
      this._write(socket, failure(message.requestId, result.error.code, result.error.message));
      return;
    }
    this._write(socket, success(message.requestId, result.payload));
  }

  async _handleParsed(socket, parsed, epoch = this.transportEpoch) {
    if (!parsed.ok) {
      const requestId = parsed.requestId || null;
      this._write(socket, parsed.type === 'response' ? parsed : failure(requestId, parsed.code, parsed.message));
      return;
    }
    const message = parsed.message;
    if (!LINK_COMMANDS.has(message.type)) {
      this._write(socket, failure(
        message.requestId,
        'UNKNOWN_COMMAND',
        `Unknown command: ${message.type}`
      ));
      return;
    }

    if (socket !== this.client) {
      if (message.type === 'hello' || message.type === 'pairRequest') {
        await this._handlePairing(socket, message);
        return;
      }
      this._write(
        socket,
        failure(message.requestId, 'NOT_AUTHORIZED', 'This connection is not the active master.')
      );
      return;
    }

    if (PAIRING_COMMANDS.has(message.type)) {
      await this._handlePairing(socket, message);
      return;
    }

    if (AUTHORIZED_COMMANDS.has(message.type) && !this._isAuthorized(socket)) {
      this._write(
        socket,
        failure(message.requestId, 'NOT_AUTHORIZED', 'This Master is not paired with this Slave.')
      );
      return;
    }

    if (message.type === 'scheduledPlay') {
      this._handleScheduledPlay(socket, message);
      return;
    }
    if (message.type === 'sessionSync') {
      if (!this._isAuthorized(socket)) {
        this._write(
          socket,
          failure(message.requestId, 'NOT_AUTHORIZED', 'This Master is not paired with this Slave.')
        );
        return;
      }
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : null;
      if (!payload) {
        this._write(socket, failure(message.requestId, 'MALFORMED', 'sessionSync requires a payload.'));
        return;
      }
      this.emit('session-sync', payload);
      this._write(socket, success(message.requestId, { accepted: true }));
      return;
    }
    if (message.type === 'timeSync') {
      const nowWall = typeof this.clock.sharedNow === 'function' ? this.clock.sharedNow() : sharedNow();
      this._respondTimeSync(socket, message, this.clock.monotonicNow(), nowWall);
      return;
    }
    try {
      const result = await execute(this.player, message, {
        mediaRoot: this.mediaRoot(),
        openApp: this.openApp,
        isCurrent: () => this.transportEpoch === epoch
      });
      if (result.ok) {
        this._write(socket, success(message.requestId, result.payload));
        if (message.type === 'load') this.emit('mirrored-load', result.payload);
      } else {
        this._write(
          socket,
          failure(
            message.requestId,
            result.error.code,
            result.error.message,
            result.error.mediaPath ? { mediaPath: result.error.mediaPath } : undefined
          )
        );
      }
    } catch (error) {
      this._write(socket, failure(message.requestId, 'PLAYER_ERROR', error.message));
    }
  }

  async _handlePairing(socket, message) {
    if (message.type === 'hello') {
      return this._handleHello(socket, message);
    }
    if (message.type === 'pairRequest') {
      return this._handlePairRequest(socket, message);
    }
    if (message.type === 'pairResponse') {
      this._write(
        socket,
        failure(message.requestId, 'WRONG_ROLE', 'Only the Slave accepts or rejects pairing.')
      );
      return;
    }
    if (message.type === 'unpair') {
      if (socket !== this.client || !this._isAuthorized(socket)) {
        this._write(socket, failure(message.requestId, 'NOT_AUTHORIZED', 'Not paired.'));
        return;
      }
      if (this.config) this.config.clearPaired();
      socket.authorizedDeviceId = null;
      this.authorizedDeviceId = null;
      this._write(socket, success(message.requestId, { unpaired: true }));
      this.emit('unpaired');
      this.emit('state');
      socket.closeReason = 'unpaired by the Master';
      socket.destroy();
    }
  }

  _handleHello(socket, message) {
    const problem = identityPayloadError(message.payload);
    if (problem) {
      this._write(socket, failure(message.requestId, problem.code, problem.message));
      return;
    }
    const deviceId = message.payload.deviceId;
    const paired = this.config ? this.config.getPaired() : null;

    if (paired && paired.deviceId === deviceId) {
      this._authorize(socket, deviceId);
      if (this.config) {
        this.config.updatePairedEndpoint(socket.remoteHost || paired.host, paired.port);
      }
      this._write(socket, success(message.requestId, {
        authorized: true,
        paired: true,
        deviceId: this.config ? this.config.data.deviceId : null,
        deviceName: this.config ? this.config.data.deviceName : 'Slave',
        role: 'slave'
      }));
      if (this.trace) this.trace.stage('slave_hello_handled', 'authorized');
      this.emit('authorized', { deviceId, automatic: true });
      this.emit('state');
      return;
    }

    // Unknown device — hello alone does not authorize. Client should send pairRequest.
    this._write(socket, success(message.requestId, {
      authorized: false,
      paired: false,
      needsPairing: true,
      deviceId: this.config ? this.config.data.deviceId : null,
      deviceName: this.config ? this.config.data.deviceName : 'Slave',
      role: 'slave'
    }));
    if (this.trace) this.trace.stage('slave_hello_handled', 'needsPairing');
  }

  _handlePairRequest(socket, message) {
    const problem = identityPayloadError(message.payload);
    if (problem) {
      this._write(socket, failure(message.requestId, problem.code, problem.message));
      return;
    }
    if (message.payload.role !== 'master') {
      this._write(socket, failure(message.requestId, 'INVALID_IDENTITY', 'Only a Master may request pairing.'));
      return;
    }

    const paired = this.config ? this.config.getPaired() : null;
    if (paired && paired.deviceId === message.payload.deviceId) {
      this._authorize(socket, message.payload.deviceId);
      if (this.config) {
        this.config.updatePairedEndpoint(socket.remoteHost || paired.host, paired.port);
      }
      this._write(socket, success(message.requestId, {
        accepted: true,
        automatic: true,
        deviceId: this.config ? this.config.data.deviceId : null,
        deviceName: this.config ? this.config.data.deviceName : 'Slave',
        role: 'slave'
      }));
      this.emit('authorized', { deviceId: message.payload.deviceId, automatic: true });
      this.emit('state');
      return;
    }

    if (paired && paired.deviceId !== message.payload.deviceId) {
      this._write(
        socket,
        failure(
          message.requestId,
          'ALREADY_PAIRED',
          'This Slave is already paired with another Master. Remove that connection first.'
        )
      );
      return;
    }

    if (this.pendingPair && this.pendingPair.socket !== socket) {
      this._write(
        socket,
        failure(message.requestId, 'PAIR_PENDING', 'A connection request is already waiting.')
      );
      return;
    }
    this._clearPendingPair('replaced');
    this.pendingPair = {
      requestId: message.requestId,
      deviceId: message.payload.deviceId,
      deviceName: message.payload.deviceName,
      host: socket.remoteHost,
      port: Number(message.payload.port) || 47631,
      socket,
      receivedAt: new Date().toISOString()
    };
    if (this.trace) {
      this.trace.stage('slave_pair_request_ui', message.payload.deviceName || message.payload.deviceId);
    }
    this.emit('pair-request', {
      requestId: message.requestId,
      deviceId: message.payload.deviceId,
      deviceName: message.payload.deviceName,
      host: socket.remoteHost,
      role: 'master'
    });
    this.emit('state');
    // Response is deferred until Accept / Reject.
  }

  /**
   * Ask the connected Master for its playlist and player state.
   * The Master answers on the same socket.
   */
  request(type, payload = {}, timeoutMs = 8000) {
    const socket = this.client;
    if (!socket || socket.destroyed) {
      return Promise.reject(Object.assign(new Error('Master is not connected.'), { code: 'NOT_CONNECTED' }));
    }
    const requestId = `slave-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(requestId);
        reject(Object.assign(new Error(`Master did not answer ${type}.`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.outbound.set(requestId, { resolve, reject, timer, socket });
      this._write(socket, {
        type,
        requestId,
        source: 'slave',
        payload: payload || {}
      });
    });
  }

  _takeResponse(line, socket) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      return false;
    }
    if (!message || message.type !== 'response' || !this.outbound.has(message.requestId)) return false;
    const pending = this.outbound.get(message.requestId);
    if (!pending || pending.socket !== socket || socket !== this.client || !this._isAuthorized(socket)) {
      return false;
    }
    clearTimeout(pending.timer);
    this.outbound.delete(message.requestId);
    pending.resolve(message);
    return true;
  }

  _write(socket, message) {
    if (!socket || socket.destroyed || socket.writable === false) {
      const kind = message && message.type ? message.type : 'message';
      console.error(
        `[link] could not write ${kind} to ${peerEndpoint(socket)}: socket not writable`
      );
      return;
    }
    let body;
    try {
      body = encode(message);
    } catch (error) {
      console.error(`[link] could not encode outbound message: ${error.message}`);
      return;
    }
    try {
      socket.write(body, (writeError) => {
        if (writeError) {
          console.error(
            `[link] write failed to ${peerEndpoint(socket)}: ${writeError.code || writeError.message}`
          );
        }
      });
    } catch (error) {
      console.error(`[link] write threw to ${peerEndpoint(socket)}: ${error.message}`);
    }
  }
}

module.exports = { SlaveServer };
