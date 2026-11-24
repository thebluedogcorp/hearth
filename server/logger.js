'use strict';

const fs = require('node:fs');
const path = require('node:path');

class Logger {
  constructor(dataDir) {
    this.logDir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.currentDay = '';
    this.stream = null;
  }

  file() {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.currentDay) {
      if (this.stream) this.stream.end();
      this.currentDay = day;
      this.stream = fs.createWriteStream(path.join(this.logDir, `server-${day}.log`), { flags: 'a' });
      this.stream.on('error', () => {});
      this.prune(day);
    }
    return this.stream;
  }

  prune(currentDay) {
    try {
      const files = fs.readdirSync(this.logDir).filter(name => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
      while (files.length > 14) fs.unlinkSync(path.join(this.logDir, files.shift()));
      if (files.length && files[0] > currentDay) fs.unlinkSync(path.join(this.logDir, files[0]));
    } catch { /* logging must never prevent startup */ }
  }

  write(level, message, details) {
    const entry = { time: new Date().toISOString(), level, message, ...(details ? { details: this.sanitize(details) } : {}) };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
    this.file().write(line);
  }

  sanitize(value) {
    try {
      const encoded = JSON.stringify(value, (key, item) => /password|token|secret|authorization|cookie/i.test(key) ? '[redacted]' : item);
      return JSON.parse(encoded);
    } catch {
      return { message: 'Unloggable detail' };
    }
  }

  info(message, details) { this.write('info', message, details); }
  warn(message, details) { this.write('warning', message, details); }
  error(message, details) { this.write('error', message, details); }
}

module.exports = { Logger };
