/**
 * Timestamped connection stages for Master ↔ Slave link diagnostics.
 * Protocol: plain TCP, one JSON object per line (no TLS, no WebSocket).
 */

const MAX_ENTRIES = 40;

const STAGES = {
  master_resolve: 'Master: resolving target host and port',
  master_tcp_connecting: 'Master: opening TCP socket',
  master_tcp_connected: 'Master: TCP connected (no application data yet)',
  master_send_hello: 'Master: sending hello (JSON line)',
  master_hello_response: 'Master: received hello response',
  master_send_pair_request: 'Master: sending pairRequest (JSON line)',
  master_pair_response: 'Master: received pairRequest response',
  master_tcp_closed: 'Master: TCP closed',
  master_tcp_error: 'Master: TCP error',
  slave_listener_ready: 'Slave: listening on TCP port',
  slave_tcp_accepted: 'Slave: accepted inbound TCP connection',
  slave_first_line: 'Slave: received first JSON line',
  slave_hello_handled: 'Slave: hello handled',
  slave_pair_request_ui: 'Slave: pairRequest waiting for Accept/Reject in UI',
  slave_pair_accepted: 'Slave: pairing accepted',
  slave_pair_rejected: 'Slave: pairing rejected',
  ipc_pair_request: 'Slave: pair-request sent to UI (Electron IPC)',
  ipc_pair_request_failed: 'Slave: could not deliver pair-request to UI'
};

function sanitizeDetail(detail) {
  if (detail == null) return '';
  const text = String(detail);
  if (/private|secret|key|password|token/i.test(text)) return '[redacted]';
  return text.slice(0, 500);
}

class ConnectionTrace {
  constructor() {
    this.entries = [];
    this.lastFailedStage = null;
    this.lastFailedDetail = null;
  }

  stage(id, detail) {
    const label = STAGES[id] || id;
    const entry = {
      at: new Date().toISOString(),
      id,
      label,
      detail: sanitizeDetail(detail)
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    console.error(`[link-trace] ${entry.at} ${label}${entry.detail ? ' — ' + entry.detail : ''}`);
    return entry;
  }

  fail(id, detail) {
    this.lastFailedStage = id;
    this.lastFailedDetail = sanitizeDetail(detail);
    return this.stage(id, detail);
  }

  snapshot() {
    return {
      protocol: 'tcp-ndjson',
      protocolNote: 'Plain TCP port with one JSON command per line. No TLS or WebSocket.',
      stages: this.entries.slice(-12),
      lastFailedStage: this.lastFailedStage,
      lastFailedStageLabel: this.lastFailedStage ? STAGES[this.lastFailedStage] || this.lastFailedStage : null,
      lastFailedDetail: this.lastFailedDetail
    };
  }

  clearFailure() {
    this.lastFailedStage = null;
    this.lastFailedDetail = null;
  }
}

module.exports = { ConnectionTrace, STAGES };
