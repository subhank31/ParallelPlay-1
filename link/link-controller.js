const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { MasterClient } = require('./master-client');
const { SlaveServer } = require('./slave-server');
const { endpointError, listenPortError, success, failure } = require('./protocol');
const { monotonicNow, sharedNow, synchronize, emptyEstimate } = require('./clock-sync');
const { defaultLeadMs, planScheduledPlay } = require('./scheduled-command');
const { toRelativeMediaPath } = require('./media-path');
const { DEFAULT_PORT } = require('./config-store');
const { masterSessionPayload, resolveSessionFile } = require('./session-state');
const { reconcileCommands, mediaTypeFromPath } = require('../playlist-ui');
const { ConnectionTrace } = require('./connection-trace');

class LinkController extends EventEmitter {
  constructor(player, options = {}) {
    super();
    this.trace = options.trace || new ConnectionTrace();
    this.player = player;
    this.config = options.config || null;
    this.role = (this.config && this.config.data.role) || 'master';
    this.server = null;
    this.listening = false;
    this.listenPort = (this.config && this.config.data.listenPort) || DEFAULT_PORT;
    this.masterConnected = false;
    this.clock = options.clock || { monotonicNow, sharedNow };
    this.sampleCount = options.sampleCount == null ? 10 : options.sampleCount;
    this.sampleIntervalMs = options.sampleIntervalMs == null ? 20 : options.sampleIntervalMs;
    this.leadMs = options.leadMs == null ? defaultLeadMs() : options.leadMs;
    this.sleep = options.sleep;
    this.syncState = emptyEstimate();
    this.lastSyncWall = null;
    this.lastExecution = null;
    this.client = new MasterClient({ clock: this.clock, trace: this.trace });
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.autoReconnect = true;
    this.pairingState = 'idle'; // idle | requesting | paired | rejected
    this.lastPairError = null;
    this.slaveUnavailable = false;
    this.pendingPairRequest = null;
    this.slaveMediaStatus = null; // ready | missing | null
    this.mirroredMediaPath = null;
    this.mirroredMedia = null;
    this.openApp = options.openApp || null;
    this.checkFirewall = typeof options.checkFirewall === 'function' ? options.checkFirewall : null;
    this.firewall = null;
    this.publishedSession = { playlist: [], currentIndex: null, playAll: false, published: false };
    this.pairRetryDelayMs = options.pairRetryDelayMs == null ? 1000 : options.pairRetryDelayMs;
    this._keepListening = false;
    this._desiredListenPort = this.listenPort;
    this._listenChain = Promise.resolve();
    this._relistenTimer = null;
    this._relistenAttempt = 0;
    this._pairAttempt = 0;
    this._pairRequestActive = false;
    this._pairInFlight = null;
    this._closed = false;
    this.linkReady = false;
    this.sessionDesired = false;
    this._wireClient();
  }

  _wireClient() {
    this.client.on('disconnected', () => {
      this._clearSync();
      this.pairingState = this.config && this.config.getPaired() ? 'paired' : this.pairingState;
      this.linkReady = false;
      this.emit('event', Object.assign({ event: 'disconnected' }, this.snapshot()));
      if (this._pairRequestActive) return;
      this._scheduleReconnect();
    });
    this.client.on('state', () => {
      this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    });
    this.client.on('request', (message) => {
      this._answerSlave(message).catch((error) => {
        this._replyToSlave(message, failure(
          message && message.requestId,
          'STATE_UNAVAILABLE',
          error.message || 'The master could not read the player.'
        ));
      });
    });
    this.client.on('execution', (payload) => {
      this.lastExecution = payload;
      console.error(
        `[link] scheduled execution masterTarget=${payload.masterTargetTime} localTarget=${payload.localTargetTime} actual=${payload.actualLocalTime} errorMs=${payload.errorMs}`
      );
      this.emit('event', Object.assign({ event: 'execution' }, payload, this.snapshot()));
    });
  }

  snapshot() {
    const paired = this.config ? this.config.getPaired() : null;
    const connected =
      this.role === 'master'
        ? this.client.connectionState === 'connected'
        : this.masterConnected && !!this.authorizedOnSlave();
    return {
      role: this.role,
      connection:
        this.role === 'master'
          ? this.client.connectionState
          : this.listening
            ? this.masterConnected
              ? 'connected'
              : 'listening'
            : 'disconnected',
      paired: !!paired,
      pairingState: this.pairingState,
      host: this.role === 'master' ? (this.client.host || (paired && paired.host) || null) : null,
      port:
        this.role === 'slave'
          ? this.listenPort
          : this.client.port || (paired && paired.port) || DEFAULT_PORT,
      listening: this.listening,
      masterConnected: this.masterConnected,
      authorized: this.role === 'master' ? connected : this.authorizedOnSlave(),
      reconnecting: this.role === 'master' && !!this.reconnectTimer,
      reconnectAttempt: this.reconnectAttempt,
      lastPairError: this.lastPairError,
      slaveUnavailable: this.slaveUnavailable === true,
      firewall: this.role === 'slave' ? this.firewall : null,
      pendingPairRequest: this.pendingPairRequest,
      identity: this.config ? this.config.identity() : null,
      peer: paired,
      mediaRoot: this.config ? this.config.data.mediaRoot || '' : '',
      slaveMediaStatus: this.slaveMediaStatus,
      mirroredMedia: this.mirroredMedia,
      mirroredMediaPath: this.mirroredMediaPath,
      leadMs: this.leadMs,
      clock: this.clockSnapshot(),
      lastExecution: this.lastExecution,
      connectionTrace: this.trace.snapshot()
    };
  }

  authorizedOnSlave() {
    return !!(this.server && this.server.authorizedDeviceId);
  }

  clockSnapshot() {
    const sync = this.syncState || emptyEstimate();
    const shown = sync.diagnostic && Number.isFinite(sync.diagnostic.offsetMs) ? sync.diagnostic : null;
    return {
      synchronized: sync.synchronized === true,
      offsetMs: shown ? shown.offsetMs : null,
      rttMs: shown ? shown.rttMs : null,
      jitterMs: shown ? shown.jitterMs : null,
      sampleCount: shown ? shown.sampleCount || 0 : 0,
      lastSyncWall: this.lastSyncWall
    };
  }

  _clearSync() {
    this.syncState = emptyEstimate();
    this.lastSyncWall = null;
    this.lastExecution = null;
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this.role !== 'master') return;
    const paired = this.config && this.config.getPaired();
    if (!paired) return;
    if (this.client.connectionState === 'connected' || this.client.connectionState === 'connecting') {
      return;
    }
    if (this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * Math.pow(1.5, Math.min(this.reconnectAttempt, 8)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.role !== 'master' || !this.autoReconnect) return;
      const peer = this.config && this.config.getPaired();
      if (!peer) return;
      try {
        await this._connectAndAuthorize(peer.host, peer.port, { requestPairIfNeeded: false });
        this.linkReady = true;
        this.reconnectAttempt = 0;
        this.lastPairError = null;
      } catch (error) {
        this.linkReady = false;
        this.lastPairError = error && error.message ? error.message : null;
        this._scheduleReconnect();
      }
      this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    }, delay);
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
  }

  async setRole(role) {
    if (role !== 'master' && role !== 'slave') {
      return { ok: false, error: 'Role must be master or slave.' };
    }
    if (role !== this.role) {
      const paired = this.config && this.config.getPaired();
      if (paired) {
        return {
          ok: false,
          error:
            'Remove the current pairing before changing role. A device cannot be Master and Slave at once.',
          requiresUnpair: true,
          snapshot: this.snapshot()
        };
      }
      this._pairAttempt += 1;
      this._pairRequestActive = false;
      this.autoReconnect = false;
      this._clearReconnect();
      await this.client.disconnect();
      await this.stopListening();
      this._clearSync();
      this.role = role;
      this.pairingState = 'idle';
      this.lastPairError = null;
      this.slaveUnavailable = false;
      this.pendingPairRequest = null;
      this.slaveMediaStatus = null;
      if (this.config) this.config.setRole(role);
      this.autoReconnect = true;
    }
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ok: true, snapshot: this.snapshot() };
  }

  async listen(port) {
    if (this.role !== 'slave') {
      return { ok: false, error: 'Switch this Mac to slave before listening.' };
    }
    const problem = listenPortError(port);
    if (problem) return { ok: false, error: problem };
    this._keepListening = true;
    this._desiredListenPort = Number(port);
    return this._enqueueListen(() => this._openListener());
  }

  _enqueueListen(work) {
    const run = this._listenChain.then(work, work);
    this._listenChain = run.then(() => {}, () => {});
    return run;
  }

  _clearRelisten() {
    if (this._relistenTimer) {
      clearTimeout(this._relistenTimer);
      this._relistenTimer = null;
    }
  }

  _scheduleRelisten() {
    if (this._closed || !this._keepListening || this.role !== 'slave') return;
    if (this._relistenTimer) return;
    const delay = Math.min(5000, 500 * Math.pow(1.5, Math.min(this._relistenAttempt, 6)));
    this._relistenAttempt += 1;
    this._relistenTimer = setTimeout(() => {
      this._relistenTimer = null;
      if (this._closed || !this._keepListening || this.role !== 'slave') return;
      this._enqueueListen(() => this._openListener()).catch(() => {});
    }, delay);
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
  }

  _bindServer(server) {
    const current = () => this.server === server;
    server.on('master-connected', () => {
      if (!current()) return;
      this.masterConnected = true;
      this.emit('event', Object.assign({ event: 'master-connected' }, this.snapshot()));
    });
    server.on('master-disconnected', () => {
      if (!current()) return;
      this.masterConnected = false;
      this.pendingPairRequest = null;
      this.emit('event', Object.assign({ event: 'master-disconnected' }, this.snapshot()));
    });
    server.on('pair-request', (request) => {
      if (!current()) return;
      this.pendingPairRequest = request;
      this.pairingState = 'requesting';
      this.trace.stage('slave_pair_request_ui', request.deviceName || request.deviceId || '');
      this.trace.stage('ipc_pair_request', request.requestId || '');
      this.emit('event', Object.assign({ event: 'pair-request' }, request, this.snapshot()));
    });
    server.on('paired', (peer) => {
      if (!current()) return;
      this.pendingPairRequest = null;
      this.pairingState = 'paired';
      this.emit('event', Object.assign({ event: 'paired' }, { peer }, this.snapshot()));
    });
    server.on('authorized', () => {
      if (!current()) return;
      this.pairingState = 'paired';
      this.emit('event', Object.assign({ event: 'authorized' }, this.snapshot()));
      this.requestMasterSession().catch(() => {});
    });
    server.on('session-sync', (payload) => {
      if (!current()) return;
      this._applyMasterSession(payload).catch(() => {});
    });
    server.on('unpaired', () => {
      if (!current()) return;
      this.pairingState = 'idle';
      this.emit('event', Object.assign({ event: 'unpaired' }, this.snapshot()));
    });
    server.on('pair-rejected', () => {
      if (!current()) return;
      this.pendingPairRequest = null;
      this.pairingState = this.config && this.config.getPaired() ? 'paired' : 'idle';
      this.emit('event', Object.assign({ event: 'pair-rejected' }, this.snapshot()));
    });
    server.on('pair-cancelled', () => {
      if (!current()) return;
      this.pendingPairRequest = null;
      if (!this.config || !this.config.getPaired()) this.pairingState = 'idle';
      this.emit('event', Object.assign({ event: 'pair-cancelled' }, this.snapshot()));
    });
    server.on('connection-error', (error) => {
      if (!current()) return;
      const message = error && error.message ? error.message : 'Connection failed.';
      this.emit('event', { event: 'error', error: message, snapshot: this.snapshot() });
    });
    server.on('error', (error) => {
      const message = error && error.message ? error.message : 'Slave listener failed.';
      this.emit('event', { event: 'error', error: message, snapshot: this.snapshot() });
      if (!current() || !this._keepListening) return;
      this.listening = false;
      console.error(`[link] slave listener error: ${message}`);
      this._scheduleRelisten();
    });
  }

  async _openListener() {
    if (this._closed || !this._keepListening || this.role !== 'slave') {
      return { ok: false, error: 'Not listening.', snapshot: this.snapshot() };
    }
    if (
      this.server &&
      this.listening &&
      Number(this.listenPort) === Number(this._desiredListenPort)
    ) {
      return { ok: true, snapshot: this.snapshot() };
    }
    await this._closeServer();
    if (this._closed || !this._keepListening || this.role !== 'slave') {
      return { ok: false, error: 'Not listening.', snapshot: this.snapshot() };
    }
    const port = this._desiredListenPort;
    const server = new SlaveServer({
      player: this.player,
      host: '0.0.0.0',
      config: this.config,
      enforcePairing: true,
      clock: this.clock,
      openApp: this.openApp,
      trace: this.trace
    });
    this._bindServer(server);
    this.server = server;
    try {
      const info = await server.start(Number(port));
      if (this._closed || !this._keepListening || this.server !== server) {
        await server.stop();
        if (this.server === server) this.server = null;
        this.listening = false;
        return { ok: false, error: 'Not listening.', snapshot: this.snapshot() };
      }
      this.listening = true;
      this.listenPort = info.port;
      this._relistenAttempt = 0;
      if (this.config) this.config.setListenPort(info.port);
      this.trace.stage('slave_listener_ready', `${info.host}:${info.port}`);
      this.emit('event', Object.assign({ event: 'listening' }, this.snapshot()));
      this._refreshFirewall();
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      try {
        await server.stop();
      } catch (stopError) {
        // The failed listener is already closed.
      }
      this.listening = false;
      if (this.server === server) this.server = null;
      const message = error && error.message ? error.message : 'Slave listener failed.';
      console.error(`[link] slave listen failed: ${message}`);
      this._scheduleRelisten();
      return { ok: false, error: message, snapshot: this.snapshot() };
    }
  }

  _refreshFirewall() {
    if (!this.checkFirewall) return;
    Promise.resolve()
      .then(() => this.checkFirewall())
      .then((state) => {
        this.firewall = state || null;
        if (state && state.enabled && !state.signed) {
          console.error(
            `[link] ${state.appPath} is not code signed; macOS Firewall drops every incoming connection to it. Install a signed build.`
          );
        } else if (state && (state.blocked || (state.enabled && !state.listed))) {
          console.error(
            `[link] macOS Firewall ${state.blocked ? 'blocks' : 'has not approved'} incoming connections for this app`
          );
        }
        this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
      })
      .catch(() => {});
  }

  async _closeServer() {
    this._clearRelisten();
    this.listening = false;
    this.masterConnected = false;
    this.pendingPairRequest = null;
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
  }

  /**
   * Legacy raw TCP connect (diagnostics / tests). Prefer requestPairing.
   */
  async connect(host, port) {
    if (this.role !== 'master') {
      return { ok: false, error: 'Switch this Mac to master before connecting.' };
    }
    const problem = endpointError(host, port);
    if (problem) return { ok: false, error: problem };
    try {
      this._clearSync();
      this._clearReconnect();
      await this.client.connect({ host, port: Number(port) });
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      return { ok: false, error: error.message, snapshot: this.snapshot() };
    }
  }

  /**
   * Operator-facing: request connection / pairing with a Slave.
   */
  requestPairing(host, port = DEFAULT_PORT) {
    if (this.role !== 'master') {
      return Promise.resolve({ ok: false, error: 'Switch this Mac to Master before adding a Slave.' });
    }
    if (this.config && this.config.getPaired()) {
      return Promise.resolve({
        ok: false,
        error: 'A Slave is already paired. Remove that connection first.',
        snapshot: this.snapshot()
      });
    }
    const problem = endpointError(host, port);
    if (problem) return Promise.resolve({ ok: false, error: problem });
    const target = `${host}:${Number(port)}`;
    if (this._pairInFlight && this._pairTarget === target) return this._pairInFlight;
    this._pairTarget = target;
    this._pairAttempt += 1;
    const attempt = this._pairAttempt;
    if (this.client && this.client.connectionState !== 'disconnected') this.client.disconnect();
    this._pairInFlight = this._requestUntilPaired(host, Number(port), attempt).finally(() => {
      if (this._pairAttempt === attempt) this._pairInFlight = null;
    });
    return this._pairInFlight;
  }

  _terminalPairError(error) {
    const code = error && error.code;
    return (
      code === 'PAIR_REJECTED' ||
      code === 'ALREADY_PAIRED' ||
      code === 'INVALID_ENDPOINT' ||
      code === 'INVALID_IDENTITY' ||
      code === 'WRONG_ROLE' ||
      code === 'TIMEOUT'
    );
  }

  _slaveUnreachable(error) {
    const code = error && error.code;
    return (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EHOSTUNREACH' ||
      code === 'EHOSTDOWN' ||
      code === 'ENETUNREACH' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'CONNECT_TIMEOUT' ||
      code === 'NOT_CONNECTED'
    );
  }

  async _requestUntilPaired(host, port, attempt) {
    this.pairingState = 'requesting';
    this.lastPairError = null;
    this.slaveUnavailable = false;
    this.autoReconnect = true;
    this._pairRequestActive = true;
    this.emit('event', Object.assign({ event: 'pair-requesting' }, this.snapshot()));
    let delay = this.pairRetryDelayMs;
    try {
      while (!this._closed && this._pairAttempt === attempt && this.role === 'master') {
        if (this.config && this.config.getPaired()) {
          this.slaveUnavailable = false;
          return { ok: true, snapshot: this.snapshot() };
        }
        try {
          return await this._connectAndAuthorize(host, port, { requestPairIfNeeded: true });
        } catch (error) {
          if (this._closed || this._pairAttempt !== attempt || this.role !== 'master') {
            return { ok: false, replaced: true, error: error.message, snapshot: this.snapshot() };
          }
          if (this._terminalPairError(error)) {
            this.pairingState = 'rejected';
            this.slaveUnavailable = false;
            this.lastPairError = error.message;
            this.emit('event', Object.assign({ event: 'pair-failed' }, this.snapshot()));
            return { ok: false, error: error.message, snapshot: this.snapshot() };
          }
          this.pairingState = 'requesting';
          this.slaveUnavailable = this._slaveUnreachable(error);
          this.lastPairError = this.slaveUnavailable ? 'Slave unavailable' : error.message;
          this.emit('event', Object.assign({ event: 'pair-requesting' }, this.snapshot()));
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(5000, Math.round(delay * 1.5));
        }
      }
      return { ok: false, replaced: true, error: 'Connection request replaced.', snapshot: this.snapshot() };
    } finally {
      if (this._pairAttempt === attempt) this._pairRequestActive = false;
    }
  }

  async _connectAndAuthorize(host, port, { requestPairIfNeeded }) {
    this._clearReconnect();
    this._clearSync();
    this.trace.stage('master_resolve', `${host}:${port}`);
    await this.client.connect({ host, port: Number(port) });
    this.slaveUnavailable = false;
    if (requestPairIfNeeded) {
      this.lastPairError = null;
      this.pairingState = 'requesting';
      this.emit('event', Object.assign({ event: 'pair-requesting' }, this.snapshot()));
    }

    const identity = this.config
      ? this.config.identity()
      : { deviceId: 'anonymous', deviceName: 'Master', role: 'master' };

    let hello;
    try {
      hello = await this.client.request(
        'hello',
        {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          role: 'master',
          port: Number(port)
        },
        8000
      );
    } catch (error) {
      if (error && (error.code === 'DISCONNECTED' || error.code === 'NOT_CONNECTED' || error.code === 'SLAVE_ERROR')) {
        const bytes = typeof error.bytesReceived === 'number' ? error.bytesReceived : null;
        const detail =
          bytes === 0
            ? 'TCP connected but the Slave sent 0 bytes (failure before hello JSON response).'
            : error.message || 'Slave closed during hello.';
        this.trace.fail('master_tcp_closed', detail);
        const masterLan = this.client.localAddress || 'this Master’s LAN address';
        const slaveLogHint =
          `On the Slave Mac (${host}), open ~/Library/Application Support/Parallel Playout/logs/parallel-playout.log ` +
          `while you click Request Connection. Look for: connection from ${masterLan}. ` +
          'If that line is missing, macOS Firewall (or another filter) dropped the connection before Parallel Playout saw it. ' +
          'If it shows remote=unknown:? and read ENOTCONN, the Slave copy of Parallel Playout is not code signed, so macOS Firewall drops the connection; install a signed build there. ' +
          'If the line is present but ends with 0 bytes here, update Parallel Playout on the Slave to the latest build, ' +
          'confirm role Slave and Listening on port ' +
          port +
          ', and allow the app in System Settings › Network › Firewall.';
        this.client.disconnect();
        throw Object.assign(
          new Error(
            `Connection failed after TCP connect to ${host}:${port}. ${detail} ` +
              'This link uses plain TCP and JSON lines (not TLS or WebSocket). ' +
              slaveLogHint
          ),
          { code: 'SLAVE_CLOSED', bytesReceived: bytes, masterLan, slaveHost: host }
        );
      }
      if (error && error.code === 'TIMEOUT') {
        this.client.disconnect();
      }
      throw error;
    }

    if (hello.ok && hello.payload && hello.payload.authorized === true) {
      this._storePairFromRemote(host, port, hello.payload, identity);
      this.pairingState = 'paired';
      this.linkReady = true;
      this.reconnectAttempt = 0;
      this.emit('event', Object.assign({ event: 'paired' }, this.snapshot()));
      this._pushSessionToSlave().catch(() => {});
      return { ok: true, snapshot: this.snapshot(), automatic: true };
    }

    if (!requestPairIfNeeded) {
      this.client.disconnect();
      throw Object.assign(new Error('Slave is not paired with this Master.'), {
        code: 'NOT_PAIRED'
      });
    }

    const response = await this.client.request(
      'pairRequest',
      {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        role: 'master',
        port: Number(port)
      },
      120000
    );

    if (!response.ok) {
      this.client.disconnect();
      const message =
        (response.error && response.error.message) || 'Connection request rejected.';
      this.pairingState = 'rejected';
      this.lastPairError = message;
      throw Object.assign(new Error(message), {
        code: (response.error && response.error.code) || 'PAIR_REJECTED'
      });
    }

    this._storePairFromRemote(host, port, response.payload, identity);
    this.pairingState = 'paired';
    this.linkReady = true;
    this.reconnectAttempt = 0;
    this.lastPairError = null;
    this.slaveUnavailable = false;
    this.trace.clearFailure();
    this.emit('event', Object.assign({ event: 'paired' }, this.snapshot()));
    this._pushSessionToSlave().catch(() => {});
    return { ok: true, snapshot: this.snapshot(), automatic: false };
  }

  _storePairFromRemote(host, port, remotePayload, localIdentity) {
    if (!this.config) return;
    this.config.setPaired({
      deviceId:
        (remotePayload && remotePayload.deviceId) ||
        `slave-${host}-${port}`,
      deviceName:
        (remotePayload && remotePayload.deviceName) ||
        `Parallel Playout — Slave`,
      role: 'slave',
      host,
      port: Number(port),
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    });
    // Ensure our role stays master.
    this.config.setRole(localIdentity.role || 'master');
  }

  acceptPairing(requestId) {
    if (this.role !== 'slave' || !this.server) {
      return { ok: false, error: 'Only a listening Slave can accept pairing.' };
    }
    const result = this.server.acceptPairing(requestId);
    this.pendingPairRequest = null;
    if (result.ok) this.pairingState = 'paired';
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ...result, snapshot: this.snapshot() };
  }

  rejectPairing(requestId) {
    if (this.role !== 'slave' || !this.server) {
      return { ok: false, error: 'Only a listening Slave can reject pairing.' };
    }
    const result = this.server.rejectPairing(requestId);
    this.pendingPairRequest = null;
    this.pairingState = this.config && this.config.getPaired() ? 'paired' : 'idle';
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ...result, snapshot: this.snapshot() };
  }

  async unpair() {
    this._pairAttempt += 1;
    this._pairRequestActive = false;
    const paired = this.config && this.config.getPaired();
    this.autoReconnect = false;
    this._clearReconnect();
    this.pendingPairRequest = null;
    this.slaveMediaStatus = null;

    if (this.role === 'master' && this.client.connectionState === 'connected') {
      try {
        await this.client.request('unpair', {}, 5000);
      } catch (error) {
        // Peer may already be gone.
      }
    }
    if (this.role === 'slave' && this.server) {
      this.server.clearAuthorization();
    }
    if (this.config) this.config.clearPaired();
    this.linkReady = false;
    this.sessionDesired = false;
    this.client.disconnect();
    this.pairingState = 'idle';
    this.lastPairError = null;
    this.slaveUnavailable = false;
    this.autoReconnect = true;
    this.emit('event', Object.assign({ event: 'unpaired' }, this.snapshot()));
    return { ok: true, snapshot: this.snapshot(), previous: paired };
  }

  async disconnect() {
    this.autoReconnect = false;
    this._clearReconnect();
    this.client.disconnect();
    this._clearSync();
    if (this.role === 'slave') await this.stopListening();
    this.autoReconnect = true;
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * Startup: slave listens; master reconnects to stored peer.
   */
  async startPairedSession() {
    if (this.role === 'slave') {
      const port = (this.config && this.config.data.listenPort) || DEFAULT_PORT;
      return this.listen(port);
    }
    const paired = this.config && this.config.getPaired();
    if (!paired) {
      this.sessionDesired = false;
      this.linkReady = false;
      return { ok: true, snapshot: this.snapshot() };
    }
    this.autoReconnect = true;
    this.sessionDesired = true;
    this.pairingState = 'paired';
    this.linkReady = false;
    try {
      await this._connectAndAuthorize(paired.host, paired.port, {
        requestPairIfNeeded: false
      });
      this.linkReady = true;
      this.lastPairError = null;
      return { ok: true, snapshot: this.snapshot() };
    } catch (error) {
      this.linkReady = false;
      this.lastPairError = error && error.message ? error.message : null;
      this._scheduleReconnect();
      return {
        ok: false,
        reconnecting: true,
        error: error.message,
        snapshot: this.snapshot()
      };
    }
  }

  ping() {
    return this._remote('ping', {}, 5000);
  }

  getRemoteStatus() {
    return this._remote('getStatus', {}, 8000);
  }

  publishSession(session) {
    const source = session && typeof session === 'object' ? session : {};
    const playlist = Array.isArray(source.playlist) ? source.playlist.filter((entry) => {
      return entry && typeof entry.path === 'string' && entry.path;
    }).map((entry) => ({
      path: entry.path,
      name: typeof entry.name === 'string' ? entry.name : entry.path.split(/[/\\]/).pop(),
      type: typeof entry.type === 'string' ? entry.type : null,
      duration: entry.duration == null || !Number.isFinite(Number(entry.duration)) ? null : Number(entry.duration),
      sizeBytes: entry.sizeBytes == null || !Number.isFinite(Number(entry.sizeBytes)) ? null : Number(entry.sizeBytes)
    })) : [];
    const index = Number.isInteger(source.currentIndex) ? source.currentIndex : null;
    this.publishedSession = {
      playlist,
      currentIndex: index,
      playAll: source.playAll === true,
      published: true
    };
    if (this.role === 'master') {
      this._pushSessionToSlave().catch(() => {});
    }
    return { ok: true };
  }

  async _buildSessionPayload() {
    let playerState = null;
    try {
      const result = await this.player.send('getState', {}, 5000);
      playerState = result && result.state ? result.state : null;
    } catch (error) {
      playerState = null;
    }
    const mediaRoot = (this.config && this.config.data && this.config.data.mediaRoot) || '';
    return masterSessionPayload(playerState, this.publishedSession, mediaRoot);
  }

  async _pushSessionToSlave() {
    if (this.role !== 'master' || this.client.connectionState !== 'connected') return { ok: false };
    const built = await this._buildSessionPayload();
    if (!built.ok) return { ok: false, error: built.error };
    const response = await this._remote('sessionSync', built.payload, 30000);
    return response && response.ok ? { ok: true } : { ok: false, error: response && response.error };
  }

  /**
   * Re-read AVPlayer after wake, then ask the Master for the authoritative session.
   * Clock sync is left untouched.
   */
  async recoverAfterWake() {
    let playerState = null;
    if (this.player && typeof this.player.send === 'function') {
      try {
        const result = await this.player.send('recover', {}, 8000);
        playerState = result && result.state ? result.state : null;
      } catch (error) {
        playerState = null;
      }
    }
    this.emit('event', { event: 'wake', state: playerState });
    if (this.role === 'slave') {
      const session = await this.requestMasterSession();
      return { ok: !session || session.ok !== false, state: playerState, session };
    }
    return { ok: true, state: playerState };
  }

  async requestMasterSession() {
    if (this.role !== 'slave' || !this.server) {
      return { ok: false, error: { code: 'WRONG_ROLE', message: 'Only the slave requests the master session.' } };
    }
    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await this.server.request('getSession', {}, 8000);
        if (response && response.ok !== false && response.payload) break;
        lastError = response && response.error;
      } catch (error) {
        lastError = { code: error.code || 'LINK_ERROR', message: error.message };
        response = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!response || response.ok === false || !response.payload) {
      const message = (lastError && lastError.message) || 'The master did not send its playback state.';
      this.emit('event', { event: 'session-error', error: message, stop: false });
      return { ok: false, error: lastError || { code: 'STATE_UNAVAILABLE', message } };
    }
    return this._applyMasterSession(response.payload);
  }

  async _answerSlave(message) {
    if (!message || message.type !== 'getSession') {
      this._replyToSlave(message, failure(message && message.requestId, 'UNKNOWN_COMMAND', 'Unknown request.'));
      return;
    }
    let playerState = null;
    try {
      const result = await this.player.send('getState', {}, 5000);
      playerState = result && result.state ? result.state : null;
    } catch (error) {
      this._replyToSlave(message, failure(message.requestId, 'STATE_UNAVAILABLE', error.message));
      return;
    }
    const mediaRoot = (this.config && this.config.data && this.config.data.mediaRoot) || '';
    const built = masterSessionPayload(playerState, this.publishedSession, mediaRoot);
    if (!built.ok) {
      this._replyToSlave(message, failure(message.requestId, built.error.code, built.error.message));
      return;
    }
    this._replyToSlave(message, success(message.requestId, built.payload));
  }

  _replyToSlave(message, body) {
    const socket = this.client && this.client.socket;
    if (!socket || socket.destroyed || !body) return;
    const { encode } = require('./protocol');
    socket.write(encode(body));
  }

  async _applyMasterSession(payload) {
    const mediaRoot = (this.config && this.config.data && this.config.data.mediaRoot) || '';
    const resolvedItems = [];
    for (const entry of payload.playlist || []) {
      const resolved = resolveSessionFile(entry, mediaRoot, (filePath) => {
        try { return fs.existsSync(filePath); } catch (error) { return false; }
      });
      if (!resolved.ok || !resolved.path) continue;
      resolvedItems.push({
        path: resolved.path,
        name: entry.name || resolved.path.split(/[/\\]/).pop(),
        type: entry.type || mediaTypeFromPath(resolved.path),
        duration: entry.duration == null || !Number.isFinite(Number(entry.duration)) ? null : Number(entry.duration)
      });
    }
    const current = resolveSessionFile(payload.item, mediaRoot, (filePath) => {
      try { return fs.existsSync(filePath); } catch (error) { return false; }
    });
    if (!current.ok) {
      await this._stopUnrecoverable(current.reason);
      return { ok: false, error: { code: 'STATE_UNAVAILABLE', message: current.reason } };
    }
    let local = null;
    try {
      const result = await this.player.send('getState', {}, 5000);
      local = result && result.state ? result.state : null;
    } catch (error) {
      local = null;
    }
    const remote = current.idle ? { idle: true } : {
      path: current.path,
      state: payload.state,
      position: payload.position,
      duration: payload.duration,
      rate: payload.rate
    };
    const plan = reconcileCommands(local, remote);
    if (!plan.ok) {
      await this._stopUnrecoverable(plan.reason);
      return { ok: false, error: { code: 'STATE_UNAVAILABLE', message: plan.reason } };
    }
    for (const command of plan.commands) {
      if (command.type === 'play' && mediaTypeFromPath(current.path) === 'video') {
        const before = await this.player.send('getState', {}, 5000).catch(() => null);
        const already = before && before.state && before.state.fullscreen === true;
        if (!already) await this.player.send('fullscreen', { enabled: true }, 10000).catch(() => null);
      }
      const fields = {};
      if (command.type === 'load') fields.path = command.path;
      if (command.type === 'seek') fields.seconds = command.seconds;
      if (command.type === 'setRate') fields.rate = command.rate;
      const result = await this.player.send(command.type, fields, 30000);
      if (!result || result.ok === false) {
        const message = (result && result.error) || 'The slave player could not match the master.';
        if (command.type === 'stop' && /no file is loaded/i.test(String(message))) continue;
        await this._stopUnrecoverable(message);
        return { ok: false, error: { code: 'PLAYER_ERROR', message } };
      }
    }
    const after = await this.player.send('getState', {}, 5000).catch(() => null);
    this.emit('event', {
      event: 'session',
      session: {
        playlist: resolvedItems,
        currentIndex: Number.isInteger(payload.currentIndex) ? payload.currentIndex : null,
        item: current.idle ? null : { path: current.path, name: payload.item && payload.item.name },
        position: payload.position,
        duration: payload.duration,
        state: payload.state,
        rate: payload.rate,
        playAll: payload.playAll === true,
        player: after && after.state ? after.state : null
      }
    });
    return { ok: true, session: payload };
  }

  async _stopUnrecoverable(reason) {
    const message = typeof reason === 'string'
      ? reason
      : (reason && reason.message) || 'Playback could not be restored after wake.';
    try {
      await this.player.send('stop', {}, 15000);
    } catch (error) { /* nothing left to stop */ }
    this.emit('event', { event: 'session-error', error: message, stop: true });
  }

  setMediaRoot(root) {
    if (!this.config) return { ok: false, error: 'Config is not available.' };
    if (!this.config.setMediaRoot(root)) {
      return { ok: false, error: 'Media directory must be an absolute path.' };
    }
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ok: true, snapshot: this.snapshot() };
  }

  setDeviceName(name) {
    if (!this.config) return { ok: false, error: 'Config is not available.' };
    if (!this.config.setDeviceName(name)) {
      return { ok: false, error: 'Enter a device name.' };
    }
    this.emit('event', Object.assign({ event: 'state' }, this.snapshot()));
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * Mirror a local absolute media load to the paired Slave as a relative path.
   */
  async mirrorLoad(absolutePath) {
    if (this.role !== 'master') return { ok: true, skipped: true };
    const paired = this.config && this.config.getPaired();
    if (!paired) return { ok: true, skipped: true, reason: 'not_paired' };
    const mediaRoot = this.config.data.mediaRoot || '';
    const relative = toRelativeMediaPath(mediaRoot, absolutePath);
    if (!relative.ok) {
      this.slaveMediaStatus = 'error';
      this.emit('event', Object.assign({ event: 'slave-media' }, this.snapshot(), {
        slaveError: relative.error
      }));
      return { ok: false, error: relative.error, snapshot: this.snapshot() };
    }
    if (this.client.connectionState !== 'connected') {
      this.slaveMediaStatus = 'disconnected';
      this._scheduleReconnect();
      return {
        ok: false,
        error: { code: 'NOT_CONNECTED', message: 'Slave is disconnected. Reconnecting…' },
        snapshot: this.snapshot()
      };
    }
    let sizeBytes = null;
    try {
      sizeBytes = fs.statSync(absolutePath).size;
    } catch (error) {
      sizeBytes = null;
    }
    const response = await this._remote(
      'load',
      {
        mediaPath: relative.mediaPath,
        name: path.basename(absolutePath),
        sizeBytes,
        source: 'master'
      },
      30000
    );
    // Attach source on the wire via request payload; player-bridge reads command.source.
    // MasterClient.request doesn't send source on envelope — include in payload and
    // have slave use payload.source fallback. Update: send via a wrap.
    if (!response.ok) {
      const code = response.error && response.error.code;
      this.slaveMediaStatus = code === 'MEDIA_NOT_FOUND' ? 'missing' : 'error';
      this.mirroredMediaPath = null;
      this.mirroredMedia = null;
      this.emit('event', Object.assign({ event: 'slave-media' }, this.snapshot(), {
        slaveError: response.error
      }));
      return { ok: false, error: response.error, snapshot: this.snapshot() };
    }
    this.slaveMediaStatus = 'ready';
    this.mirroredMediaPath = relative.mediaPath;
    this.mirroredMedia = absolutePath;
    this.emit('event', Object.assign({ event: 'slave-media' }, this.snapshot()));
    return { ok: true, mediaPath: relative.mediaPath, snapshot: this.snapshot() };
  }

  async mirrorCommand(type, payload = {}) {
    if (this.role !== 'master') return { ok: true, skipped: true };
    const paired = this.config && this.config.getPaired();
    if (!paired) return { ok: true, skipped: true, reason: 'not_paired' };
    if (this.client.connectionState !== 'connected') {
      this._scheduleReconnect();
      return {
        ok: false,
        error: { code: 'NOT_CONNECTED', message: 'Slave is disconnected. Reconnecting…' },
        snapshot: this.snapshot()
      };
    }
    const body = Object.assign({}, payload);
    if (type === 'pause' || type === 'play') {
      if (body.position == null) {
        const local = await this._localPlayback();
        if (local && Number.isFinite(local.position)) body.position = local.position;
      }
      if (!body.state) body.state = type === 'pause' ? 'paused' : 'playing';
    }
    if ((type === 'pause' || type === 'play' || type === 'seek') && !body.mediaPath && this.mirroredMediaPath) {
      body.mediaPath = this.mirroredMediaPath;
    }
    return this._remote(type, Object.assign({}, body, { source: 'master' }), 15000);
  }

  async openSlaveApp() {
    if (this.role !== 'master') {
      return { ok: false, error: { code: 'WRONG_ROLE', message: 'Only the master can open the slave app.' } };
    }
    const paired = this.config && this.config.getPaired();
    if (!paired) {
      return { ok: false, error: { code: 'NOT_PAIRED', message: 'Pair a Slave before opening its app.' } };
    }
    if (this.client.connectionState !== 'connected') {
      try {
        await this.client.connect({ host: paired.host, port: paired.port });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'NOT_RUNNING',
            message: `Parallel Playout is not running on ${paired.host}. Open it on that Mac so this command can reach it.`
          },
          snapshot: this.snapshot()
        };
      }
    }
    const response = await this._remote('openApp', {}, 8000);
    if (!response || response.ok === false) {
      const error = (response && response.error) || {
        code: 'OPEN_FAILED',
        message: 'Could not open Parallel Playout on the slave.'
      };
      if (error.code === 'NOT_AUTHORIZED') {
        error.message = 'This Slave is not paired with this Master.';
      }
      return { ok: false, error, snapshot: this.snapshot() };
    }
    return { ok: true, payload: response.payload, snapshot: this.snapshot() };
  }

  async _localPlayback() {
    if (!this.player || typeof this.player.send !== 'function') return null;
    try {
      const result = await this.player.send('getState', {}, 5000);
      const state = result && result.state;
      if (!state) return null;
      return {
        position: Number.isFinite(state.position) ? state.position : null,
        status: state.status || null,
        path: typeof state.path === 'string' ? state.path : null
      };
    } catch (error) {
      return null;
    }
  }

  async syncClock() {
    if (this.role !== 'master') {
      return { ok: false, error: { code: 'WRONG_ROLE', message: 'Only the master measures the clock offset.' } };
    }
    const result = await synchronize(
      (payload) => this.client.request('timeSync', payload, 5000),
      {
        sampleCount: this.sampleCount,
        intervalMs: this.sampleIntervalMs,
        clock: this.clock,
        sleep: this.sleep
      }
    );
    if (!result.ok) {
      return { ok: false, error: result.error, clock: this.clockSnapshot(), snapshot: this.snapshot() };
    }
    this.syncState = result.estimate;
    this.lastSyncWall = new Date().toISOString();
    const clock = this.clockSnapshot();
    console.error(
      `[link] clock offsetMs=${clock.offsetMs} rttMs=${clock.rttMs} jitterMs=${clock.jitterMs} samples=${clock.sampleCount}`
    );
    this.emit('event', Object.assign({ event: 'clock' }, this.snapshot()));
    return { ok: true, clock, snapshot: this.snapshot() };
  }

  async scheduledPlayTest() {
    if (this.role !== 'master') {
      return { ok: false, error: { code: 'WRONG_ROLE', message: 'Only the master schedules a remote play.' } };
    }
    if (!this.syncState.synchronized || !Number.isFinite(this.syncState.offsetMs)) {
      return {
        ok: false,
        error: { code: 'NOT_SYNCHRONIZED', message: 'Sync the clock before scheduling playback.' },
        snapshot: this.snapshot()
      };
    }
    const plan = planScheduledPlay({
      masterNow: this.clock.monotonicNow(),
      offsetMs: this.syncState.offsetMs,
      leadMs: this.leadMs
    });
    if (!plan.ok) return { ok: false, error: plan.error, snapshot: this.snapshot() };
    const response = await this._remote(
      'scheduledPlay',
      {
        targetMasterTime: plan.targetMasterTime,
        localTargetTime: plan.localTargetTime
      },
      8000
    );
    if (!response || response.ok === false) {
      return {
        ok: false,
        error: (response && response.error) || { code: 'LINK_ERROR', message: 'Slave did not schedule playback.' },
        snapshot: this.snapshot()
      };
    }
    return {
      ok: true,
      payload: {
        scheduled: response.payload.scheduled === true,
        localTargetTime: response.payload.localTargetTime,
        masterTargetTime: response.payload.masterTargetTime
      },
      plan: {
        targetMasterTime: plan.targetMasterTime,
        localTargetTime: plan.localTargetTime,
        leadMs: plan.leadMs,
        offsetMs: this.syncState.offsetMs
      },
      snapshot: this.snapshot()
    };
  }

  async shutdown() {
    this._closed = true;
    this._pairAttempt += 1;
    this._pairRequestActive = false;
    this.autoReconnect = false;
    this._clearReconnect();
    this._clearRelisten();
    this.client.disconnect();
    await this.stopListening();
  }

  async _remote(type, payload, timeoutMs) {
    if (this.role !== 'master') {
      return { ok: false, error: { code: 'WRONG_ROLE', message: 'Only the master sends remote commands.' } };
    }
    try {
      // Put source on the envelope for the slave parser.
      const response = await this._requestWithSource(type, payload, timeoutMs);
      return response;
    } catch (error) {
      return {
        ok: false,
        error: { code: error.code || 'LINK_ERROR', message: error.message }
      };
    }
  }

  _requestWithSource(type, payload, timeoutMs) {
    if (this.client.connectionState !== 'connected' || !this.client.socket || this.client.socket.destroyed) {
      return Promise.reject(Object.assign(new Error('Slave is not connected.'), { code: 'NOT_CONNECTED' }));
    }
    const { encode } = require('./protocol');
    const requestId = String(this.client.nextId++);
    const body = {
      type,
      requestId,
      source: 'master',
      payload: payload || {}
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.pending.delete(requestId);
        reject(Object.assign(new Error(`Slave did not answer ${type}.`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.client.pending.set(requestId, { resolve, reject, timer });
      this.client.socket.write(encode(body), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.client.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async stopListening() {
    this._keepListening = false;
    this._clearRelisten();
    return this._enqueueListen(() => this._closeServer());
  }
}

module.exports = { LinkController };
