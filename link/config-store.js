const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_PORT = 47631;

function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/i, '') || 'Mac';
  return `Parallel Playout — ${host}`;
}

function emptyConfig() {
  return {
    version: 1,
    deviceId: crypto.randomUUID(),
    deviceName: defaultDeviceName(),
    role: 'master',
    mediaRoot: '',
    listenPort: DEFAULT_PORT,
    paired: null
  };
}

/**
 * Persistent application config: device identity, role, media root, pairing.
 * Survives app/computer restarts. Cleared only by explicit unpair / role reset.
 */
class ConfigStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('ConfigStore requires a file path.');
    }
    this.filePath = filePath;
    this.data = emptyConfig();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return this.data;
      if (typeof raw.deviceId === 'string' && raw.deviceId.length >= 8) {
        this.data.deviceId = raw.deviceId;
      }
      if (typeof raw.deviceName === 'string' && raw.deviceName.trim()) {
        this.data.deviceName = raw.deviceName.trim().slice(0, 120);
      }
      if (raw.role === 'master' || raw.role === 'slave') {
        this.data.role = raw.role;
      }
      if (typeof raw.mediaRoot === 'string') {
        this.data.mediaRoot = raw.mediaRoot;
      }
      const port = Number(raw.listenPort);
      if (Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535))) {
        this.data.listenPort = port || DEFAULT_PORT;
      }
      this.data.paired = normalizePaired(raw.paired);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.save();
      } else if (error) {
        console.error(`[config] could not read ${this.filePath}: ${error.message}`);
      }
    }
    return this.data;
  }

  save() {
    const dir = path.dirname(this.filePath);
    const temporary = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2) + '\n');
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.error(`[config] could not write ${this.filePath}: ${error.message}`);
      try { fs.unlinkSync(temporary); } catch (cleanupError) { /* temp file may not exist */ }
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  identity() {
    return {
      deviceId: this.data.deviceId,
      deviceName: this.data.deviceName,
      role: this.data.role
    };
  }

  setRole(role) {
    if (role !== 'master' && role !== 'slave') return false;
    this.data.role = role;
    this.save();
    return true;
  }

  setDeviceName(name) {
    if (typeof name !== 'string' || !name.trim()) return false;
    this.data.deviceName = name.trim().slice(0, 120);
    this.save();
    return true;
  }

  setMediaRoot(root) {
    if (root == null || root === '') {
      this.data.mediaRoot = '';
      this.save();
      return true;
    }
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
    this.data.mediaRoot = path.resolve(root);
    this.save();
    return true;
  }

  setListenPort(port) {
    const value = Number(port);
    if (!Number.isInteger(value) || (value !== 0 && (value < 1024 || value > 65535))) {
      return false;
    }
    this.data.listenPort = value || DEFAULT_PORT;
    this.save();
    return true;
  }

  getPaired() {
    return this.data.paired ? { ...this.data.paired } : null;
  }

  setPaired(peer) {
    const normalized = normalizePaired(peer);
    if (!normalized) return false;
    this.data.paired = normalized;
    this.save();
    return true;
  }

  updatePairedEndpoint(host, port) {
    if (!this.data.paired) return false;
    if (typeof host === 'string' && host) this.data.paired.host = host;
    const value = Number(port);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      this.data.paired.port = value;
    }
    this.data.paired.lastSeenAt = new Date().toISOString();
    this.save();
    return true;
  }

  clearPaired() {
    this.data.paired = null;
    this.save();
  }

  isPairedDevice(deviceId) {
    return !!(
      this.data.paired &&
      typeof deviceId === 'string' &&
      this.data.paired.deviceId === deviceId
    );
  }
}

function normalizePaired(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.deviceId !== 'string' || raw.deviceId.length < 8) return null;
  if (typeof raw.deviceName !== 'string' || !raw.deviceName.trim()) return null;
  if (raw.role !== 'master' && raw.role !== 'slave') return null;
  if (typeof raw.host !== 'string' || !raw.host) return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    deviceId: raw.deviceId,
    deviceName: raw.deviceName.trim().slice(0, 120),
    role: raw.role,
    host: raw.host,
    port,
    pairedAt: typeof raw.pairedAt === 'string' ? raw.pairedAt : new Date().toISOString(),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : new Date().toISOString()
  };
}

module.exports = {
  ConfigStore,
  DEFAULT_PORT,
  defaultDeviceName,
  emptyConfig,
  normalizePaired
};
