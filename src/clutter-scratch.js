// Advice when test and script output piles up in a repo: pytest temp folders under several
// --basetemp names, and git-ignored logs and backups that nothing removes when a run ends.
// Read-only. Uses the items scanClutter already found; reads only pytest's own config files.

const fsp = require('node:fs').promises;
const path = require('node:path');
const { plural, list } = require('./util');

const MB = 1024 * 1024;
const TEST_TEMP_BIG = 1024 * MB; // one pytest temp folder this big is worth a word on its own
const SCRATCH_FILES = 20; // this many git-ignored logs and backups is a pile-up...
const SCRATCH_BYTES = 50 * MB; // ...and so is this much space
const PYTEST_CONFIGS = ['pytest.ini', '.pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'];

const size = (n) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MB))} MB`);
const sum = (a) => a.reduce((n, i) => n + i.size, 0);

async function retentionSet(dir) {
  for (const f of PYTEST_CONFIGS) {
    try {
      if (/^\s*tmp_path_retention_policy\s*=/m.test((await fsp.readFile(path.join(dir, f), 'utf8')).slice(0, 200000))) return true;
    } catch {}
  }
  return false;
}

async function scratchAdvice(dir, items) {
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Organisation', severity, title, detail });

  // pytest clears a --basetemp folder only when the next run uses that same name, so each new name
  // stays forever. tmp_path_retention_policy = "failed" removes the folders of tests that passed.
  const temps = items.filter((i) => i.testTemp === 'pytest').sort((a, b) => b.size - a.size);
  if (temps.length > 1 || (temps.length === 1 && temps[0].size >= TEST_TEMP_BIG)) {
    const total = sum(temps);
    const steps = [];
    if (temps.length > 1) steps.push('Use one --basetemp folder for every run (or leave it out, so pytest uses the system temp folder and keeps only the last 3 runs): pytest empties that folder at the start of each run, but a folder with a different name is never emptied.');
    if (!(await retentionSet(dir))) steps.push('Set tmp_path_retention_policy = "failed" in your pytest config, so the folders of tests that passed are removed when the run ends.');
    if (steps.length)
      add('test-temp-buildup', 'warn', `${plural(temps.length, 'pytest temp folder holds', 'pytest temp folders hold')} ${size(total)}`, `${list(temps.map((t) => `${t.path} (${size(t.size)})`))}. ${steps.join(' ')}`);
  }

  // Ignored logs, temp files and backups outside the folders above: scratch output from scripts and tests.
  const scratch = items.filter((i) => i.ignored && i.kind === 'file' && ['log', 'temp', 'backup'].includes(i.category)).sort((a, b) => b.size - a.size);
  const bytes = sum(scratch);
  if (scratch.length >= SCRATCH_FILES || bytes >= SCRATCH_BYTES) {
    const big = scratch.filter((i) => i.size >= MB).slice(0, 3).map((i) => `${i.path} (${size(i.size)})`);
    add('scratch-buildup', 'info', `${scratch.length} git-ignored logs and backups use ${size(bytes)}`, `${big.length ? `Largest: ${big.join(', ')}. ` : ''}Nothing removes them, so they pile up. Have the scripts and tests that write them delete them when they finish (a test can write them to pytest's tmp_path; a shell script can delete its log in an EXIT trap), or keep only the last few runs.`);
  }
  return out;
}

module.exports = { scratchAdvice };
