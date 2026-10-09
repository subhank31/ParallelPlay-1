const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 2 * 1024 * 1024;

function installFileLog(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (error) {
    return null;
  }
  const write = (text) => {
    try {
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch (error) { /* new file */ }
      if (size > MAX_BYTES) fs.renameSync(filePath, `${filePath}.1`);
      fs.appendFileSync(filePath, `${new Date().toISOString()} ${text}\n`);
    } catch (error) {
      // Logging must never stop the app.
    }
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(util.format(...args));
    };
  }
  return filePath;
}

module.exports = { installFileLog };
