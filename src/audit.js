// Append-only action history, one JSON object per line. Rotated so it cannot grow without bound.

const fs = require('node:fs');

const MAX_BYTES = 1024 * 1024; // rotate above this
const KEEP_LINES = 500;

function appendAudit(file, entry, io = fs) {
  try {
    io.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    if (io.statSync(file).size > MAX_BYTES) {
      const lines = io.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
      io.writeFileSync(file + '.tmp', lines.join('\n') + '\n');
      io.renameSync(file + '.tmp', file);
    }
  } catch {}
}

function readAudit(file, limit = 200, io = fs) {
  try {
    return io.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { appendAudit, readAudit, MAX_BYTES, KEEP_LINES };
