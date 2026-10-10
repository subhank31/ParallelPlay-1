/** Shared by the UI tests that drive a real app through DevTools. */
const fs = require('fs');
const http = require('http');
const net = require('net');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeTone(file, seconds) {
  const rate = 22050;
  const data = Buffer.alloc(rate * 2 * seconds);
  for (let i = 0; i < rate * seconds; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function devtools(port) {
  let targets = '';
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await get(`http://127.0.0.1:${port}/json`);
      if (targets.includes('Parallel Playout')) break;
    } catch (error) { /* booting */ }
    await sleep(250);
  }
  const pages = JSON.parse(targets).filter((item) => item.type === 'page');
  const page = pages.find((item) => item.title === 'Parallel Playout') || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')));
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  });
  async function evaluate(expression) {
    const id = nextId++;
    const result = await new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result && result.exceptionDetails) {
      return { error: result.exceptionDetails.exception && result.exceptionDetails.exception.description };
    }
    return result && result.result ? result.result.value : null;
  }
  return { ws, evaluate };
}

module.exports = { sleep, writeTone, freePort, devtools };
