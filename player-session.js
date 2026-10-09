const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function resolveHelperPath() {
  const bundled = path.join(process.resourcesPath || '', 'playout-engine', 'PlayoutEngine');
  if (process.resourcesPath && fs.existsSync(bundled)) return bundled;
  const root = path.join(__dirname, 'native', 'PlayoutEngine', '.build');
  const universal = path.join(root, 'apple', 'Products', 'Release', 'PlayoutEngine');
  const release = path.join(root, 'release', 'PlayoutEngine');
  const debug = path.join(root, 'debug', 'PlayoutEngine');
  if (fs.existsSync(universal)) return universal;
  if (fs.existsSync(release)) return release;
  if (fs.existsSync(debug)) return debug;
  return universal;
}

class PlayerSession extends EventEmitter {
  constructor() {
    super();
    this.binaryPath = resolveHelperPath();
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.shuttingDown = false;
    this.ready = false;
    this.readyWaiters = [];
    this.restartTimer = null;
    this.stableTimer = null;
    this.crashCount = 0;
    this.stableAfterMs = 30000;
  }

  start() {
    if (this.child || this.shuttingDown) return;
    if (!fs.existsSync(this.binaryPath)) {
      const error = 'Playout engine is not built. Run npm run build:player.';
      this._failReady(new Error(error));
      this.emit('event', { event: 'error', error });
      return;
    }

    const child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.ready = false;
    this._watchPipes(child);

    const lines = readline.createInterface({ input: child.stdout });
    // readline re-emits stream errors. A listener on stdout alone does not
    // catch that second error, and an unhandled 'error' takes down Electron.
    lines.on('error', () => {
      if (this.shuttingDown || this.child !== child) return;
      this._rejectPending(new Error('Playback engine is not running.'));
    });
    lines.on('line', (line) => {
      try {
        this._onLine(line);
      } catch (error) {
        this.emit('log', error.message);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('log', text);
    });
    child.on('error', (error) => {
      this.emit('event', { event: 'error', error: error.message });
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      try {
        lines.close();
      } catch (error) {
        // The interface is already closed when the pipe fails first.
      }
      this.ready = false;
      const error = new Error('Playback engine exited.');
      this._rejectPending(error);
      this._failReady(error);
      if (this.shuttingDown) return;
      this.crashCount += 1;
      this.emit('event', {
        event: 'helper-crashed',
        code: code,
        signal: signal || null
      });
      if (this.crashCount > 5) {
        this.emit('event', {
          event: 'helper-failed',
          error: 'Playback engine crashed repeatedly.'
        });
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), 400);
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  async send(type, fields = {}, timeoutMs = 15000) {
    await this._waitUntilReady();
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Playback engine is not running.');
    }
    const child = this.child;
    const id = String(this.nextId++);
    const payload = Object.assign({ id, type }, fields);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Playback engine timed out during ${type}.`));
      }, timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(error);
      };
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: fail
      });
      try {
        if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
          fail(new Error('Playback engine is not running.'));
          return;
        }
        child.stdin.write(JSON.stringify(payload) + '\n', (error) => {
          if (!error) return;
          fail(new Error('Playback engine is not running.'));
        });
      } catch (error) {
        fail(new Error('Playback engine is not running.'));
      }
    });
  }

  _watchPipes(child) {
    const onPipeError = () => {
      if (this.shuttingDown || this.child !== child) return;
      this._rejectPending(new Error('Playback engine is not running.'));
    };
    child.stdin.on('error', onPipeError);
    child.stdout.on('error', onPipeError);
    child.stderr.on('error', onPipeError);
  }

  _waitUntilReady(timeoutMs = 10000) {
    if (this.ready && this.child) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter.reject !== reject);
        reject(new Error('Playback engine did not start. Run npm run build:player.'));
      }, timeoutMs);
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('log', `Ignored non-JSON output: ${line}`);
      return;
    }
    if (message && message.id && this.pending.has(String(message.id))) {
      this.pending.get(String(message.id)).resolve(message);
      this.pending.delete(String(message.id));
    }
    if (message && message.event === 'ready') {
      this.ready = true;
      // A helper that crashes right after ready must still count toward the
      // restart limit, so only a helper that stays up clears the count.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      const child = this.child;
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.child === child) this.crashCount = 0;
      }, this.stableAfterMs);
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((waiter) => waiter.resolve());
      this.emit('event', { event: 'helper-ready', state: message.state || null });
    }
    if (message && (message.type === 'event' || message.event)) {
      this.emit('event', message);
    }
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  _failReady(error) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((waiter) => waiter.reject(error));
  }
}

module.exports = { PlayerSession, resolveHelperPath };
