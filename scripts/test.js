#!/usr/bin/env node
// npm test: runs every test file with one private temp folder as TMPDIR and removes it afterwards.
// The tests build hundreds of throwaway repos per run; left in the shared temp folder they add up
// to gigabytes within a day of work. Extra arguments go to node --test (--test-name-pattern=...).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-tests-'));
const args = process.argv.slice(2);
const files = args.some((a) => a.endsWith('.test.js')) ? [] : fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
let status = 1;
try {
  status = spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp } }).status ?? 1;
} finally {
  // Some tests leave read-only folders behind on purpose; make them removable first.
  try { spawnSync('chmod', ['-R', 'u+rwX', tmp]); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(status);
