function peerEndpoint(socket) {
  if (!socket) return 'unknown:?';
  let host = '';
  let port = null;
  if (typeof socket._getpeername === 'function') {
    try {
      const peer = socket._getpeername();
      if (peer && peer.address) {
        host = String(peer.address).replace(/^::ffff:/, '');
        if (peer.port != null) port = peer.port;
      }
    } catch (error) {
      /* peer name not ready yet */
    }
  }
  if (!host && socket.remoteAddress) {
    host = String(socket.remoteAddress).replace(/^::ffff:/, '');
  }
  if (port == null && socket.remotePort != null) port = socket.remotePort;
  return `${host || 'unknown'}:${port != null ? port : '?'}`;
}

function refreshPeer(socket) {
  if (!socket) return 'unknown:?';
  const label = peerEndpoint(socket);
  const host = label.split(':')[0];
  if (host !== 'unknown') {
    socket.remoteHost = host;
  }
  return label;
}

function previewBytes(chunk, max = 160) {
  if (!chunk || !chunk.length) return '(empty)';
  const slice = chunk.slice(0, max);
  return slice.toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/[^\x20-\x7E\\]/g, '.');
}

function localEndpoint(socket) {
  if (!socket) return 'unknown:?';
  const host = socket.localAddress ? String(socket.localAddress).replace(/^::ffff:/, '') : 'unknown';
  const port = socket.localPort != null ? socket.localPort : '?';
  return `${host}:${port}`;
}

function socketDiag(socket) {
  if (!socket) return 'no socket';
  const parts = [
    `destroyed=${!!socket.destroyed}`,
    `readable=${socket.readable}`,
    `writable=${socket.writable}`,
    `pending=${socket.pending === true}`,
    `local=${localEndpoint(socket)}`,
    `remote=${peerEndpoint(socket)}`
  ];
  if (typeof socket.readyState === 'string') parts.push(`readyState=${socket.readyState}`);
  return parts.join(' ');
}

module.exports = { peerEndpoint, refreshPeer, previewBytes, localEndpoint, socketDiag };
