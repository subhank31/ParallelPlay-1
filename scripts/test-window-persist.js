const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { resolveHelperPath } = require('../player-session');

const binary = resolveHelperPath();
const video = process.env.PLAYOUT_TEST_VIDEO || '/Users/subhank/Desktop/Finals/Sub 1.mp4';
const wav = '/tmp/pp-window-tone.wav';
const results = [];

function writeWav(filePath) {
  const data = Buffer.alloc(4410 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sameFrame(left, right) {
  return left && right &&
    Math.abs(left.windowX - right.windowX) <= 2 &&
    Math.abs(left.windowY - right.windowY) <= 2 &&
    Math.abs(left.windowWidth - right.windowWidth) <= 2 &&
    Math.abs(left.windowHeight - right.windowHeight) <= 2;
}

async function main() {
  writeWav(wav);
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (error) { return; }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  function send(type, fields) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ' + type)), 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify(Object.assign({ id, type }, fields || {})) + '\n');
    });
  }
  try {
    await send('getState');
    const placed = await send('setDisplay', { displayIndex: 0 });
    const first = await send('load', { path: video });
    const again = await send('load', { path: video });
    record(
      'a second video keeps the same window',
      first.ok && again.ok && again.state.windowVisible === true && sameFrame(first.state, again.state) &&
        again.state.windowWidth > 960,
      `first=${first.state && first.state.windowWidth}x${first.state && first.state.windowHeight} again=${again.state && again.state.windowWidth}x${again.state && again.state.windowHeight}`
    );
    const audio = await send('load', { path: wav });
    record(
      'audio does not leave the player window open',
      audio.ok === true && audio.state.windowVisible === false,
      `visible=${audio.state && audio.state.windowVisible}`
    );
    const back = await send('load', { path: video });
    record(
      'video returns in the same window',
      back.ok === true && back.state.windowVisible === true && sameFrame(again.state, back.state),
      `again=${again.state && again.state.windowX},${again.state && again.state.windowY} back=${back.state && back.state.windowX},${back.state && back.state.windowY}`
    );
    record(
      'display placement is kept',
      placed.ok === true && sameFrame(placed.state, back.state),
      `placed=${placed.state && placed.state.windowWidth} back=${back.state && back.state.windowWidth}`
    );
  } catch (error) {
    record('window test exception', false, error.stack || error.message);
  } finally {
    child.kill('SIGTERM');
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} window checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
