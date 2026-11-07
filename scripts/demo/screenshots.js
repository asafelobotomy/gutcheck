// Takes the README screenshots: runs the real app page against the made-up demo workspace from
// build.js (never your own repos) and saves PNGs to docs/images/. Run: npm run screenshots
// Needs a desktop session (it opens a window for a few seconds).

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./build');
const { createService } = require('../../src/service');
const { driftReport } = require('../../src/policy');
const Metrics = require('../../src/renderer/metrics');
const { version } = require('../../package.json');

const OUT = path.join(__dirname, '..', '..', 'docs', 'images');
const SRC = path.join(__dirname, '..', '..', 'src');
const DAY = 86400e3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const demo = await build();
  const known = new Map(demo.results.map((r) => [r.path, r]));
  const service = createService({ known, settings: () => ({ root: demo.root }), audit: () => {}, rescan: async (d) => known.get(d) });
  // Two weeks of made-up history, so the trend chart has a line.
  const now = Metrics.snapshot(demo.results, demo.root);
  const trend = Array.from({ length: 14 }, (_, i) => ({ ...now, ts: Date.now() - (13 - i) * DAY, avg: Math.max(0, now.avg - (13 - i) * 2), errors: now.errors + Math.round((13 - i) / 2), warns: now.warns + (13 - i) }));
  let win;
  const H = {
    'settings:get': () => ({ root: '~/Projects', deep: false, readOnly: false }),
    'app:version': () => version,
    'auth:status': () => ({ ok: true }),
    'rate:get': () => ({ core: { remaining: 4870 }, graphql: { remaining: 4952 } }),
    'scan:start': async () => {
      win.webContents.send('scan:begin', { total: demo.results.length });
      demo.results.forEach((res, i) => win.webContents.send('scan:repo', { res, done: i + 1, total: demo.results.length }));
      return { ok: true, root: '~/Projects', count: demo.results.length, rate: H['rate:get']() };
    },
    'trend:get': () => trend,
    'audit:list': () => [],
    'drift:get': () => ({ file: '~/.config/GutCheck/baseline.json', rules: driftReport(demo.results, demo.baseline) }),
    'background:get': () => ({ launchOnStartup: true, minimizeToTray: true, closeToTray: true, trayAvailable: true, scheduleEnabled: true, scheduleHours: '24' }),
    'action:plan': (_e, { items }) => service.planActions(items),
  };
  for (const ch of ['scan:one', 'action:apply', 'clutter:scan', 'quality:scan', 'tests:scan', 'quality:set', 'report:copy', 'settings:set', 'background:set', 'agents:status', 'agents:plan', 'agents:cleanup', 'agents:apply', 'agents:copy', 'open:url', 'open:folder', 'dir:pick', 'ignore:set', 'baseline:init', 'baseline:open']) H[ch] = H[ch] || (() => ({ ok: false, error: 'demo' }));
  for (const [ch, fn] of Object.entries(H)) ipcMain.handle(ch, fn);

  win = new BrowserWindow({ width: 1280, height: 820, show: true, backgroundColor: '#0f1115', webPreferences: { preload: path.join(SRC, 'preload.js'), contextIsolation: true, sandbox: true } });
  win.removeMenu();
  await win.loadFile(path.join(SRC, 'renderer', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG()); console.log('saved', name); };
  fs.mkdirSync(OUT, { recursive: true });

  await wait(500);
  await js("document.getElementById('scan').click()");
  await wait(1500);
  await shot('dashboard.png');
  await js("[...document.querySelectorAll('#repos li')].find((li) => li.textContent.includes('recipe-api')).click()");
  await shot('repo.png');
  await js("[...document.querySelectorAll('.finding button')].find((b) => b.textContent.startsWith('Add dependabot') || b.textContent.startsWith('Add MIT')).click()");
  await wait(400);
  await js("(document.querySelector('.modal button.primary') || {}).click && [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Continue')?.click()");
  await shot('review.png');
  await js("document.querySelector('.overlay')?.remove()");
  await js("document.getElementById('overview').click()");
  await shot('overview.png');
  await js("document.getElementById('baseline').click()");
  await shot('baseline.png');
  fs.rmSync(demo.root, { recursive: true, force: true });
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
