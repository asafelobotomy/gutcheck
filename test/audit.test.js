const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendAudit, readAudit, MAX_BYTES, KEEP_LINES } = require('../src/audit');

test('audit log appends, reads newest first, and rotates when it grows too large', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-audit-'));
  const file = path.join(dir, 'audit.log');
  try {
    appendAudit(file, { n: 1 });
    appendAudit(file, { n: 2 });
    assert.deepEqual(readAudit(file).map((e) => e.n), [2, 1]);
    assert.deepEqual(readAudit(path.join(dir, 'missing.log')), []);

    const big = 'x'.repeat(200);
    for (let i = 0; i < Math.ceil(MAX_BYTES / 230) + 5; i++) appendAudit(file, { n: 100 + i, pad: big });
    assert.ok(fs.statSync(file).size < MAX_BYTES, 'file must shrink after rotation');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.length < Math.ceil(MAX_BYTES / 230) + 5, 'old entries were dropped');
    assert.ok(lines.length >= KEEP_LINES, 'but the recent ones are kept');
    assert.equal(JSON.parse(lines[lines.length - 1]).n, 100 + Math.ceil(MAX_BYTES / 230) + 4, 'newest entry survives');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable audit path never throws', () => {
  assert.doesNotThrow(() => appendAudit('/proc/definitely/not/writable', { a: 1 }));
});
