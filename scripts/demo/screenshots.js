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
      await wait(200); // let the progress events land before the reply hides the bar
      return { ok: true, root: '~/Projects', count: demo.results.length, rate: H['rate:get']() };
    },
    'trend:get': () => trend,
    'audit:list': () => [
      { ts: new Date(Date.now() - 3600e3).toISOString(), ok: true, repo: 'weather-cli', title: 'Add .editorconfig', steps: [{ cmd: 'write .editorconfig' }, { cmd: 'git add .editorconfig' }] },
      { ts: new Date(Date.now() - 7200e3).toISOString(), ok: true, repo: 'notes-sync', title: 'Ignored no-dependabot-config: updates are pulled in by hand every release', via: 'app' },
      { ts: new Date(Date.now() - 86400e3).toISOString(), ok: false, repo: 'garden-planner', title: 'Push', steps: [{ cmd: 'git push' }] },
    ],
    'clutter:scan': (_e, { dirs } = {}) => service.clutterScan(dirs),
    'quality:scan': (_e, { dirs } = {}) => service.qualityScan(dirs),
    'tests:scan': (_e, { dirs } = {}) => service.testsScan(dirs),
    'agents:status': () => ({ allowActions: false, command: '/opt/GutCheck.AppImage --mcp', clients: [
      { id: 'claude-code', name: 'Claude Code', kind: 'cli', installed: true, configured: true, file: null, docs: 'https://code.claude.com/docs/en/mcp', snippet: 'claude mcp add …' },
      { id: 'cursor', name: 'Cursor', kind: 'json', installed: true, configured: false, file: '~/.cursor/mcp.json', docs: 'https://cursor.com/docs/context/mcp', snippet: '{}' },
      { id: 'gemini', name: 'Gemini CLI', kind: 'json', installed: false, configured: false, file: '~/.gemini/settings.json', docs: 'https://cursor.com/docs/context/mcp', snippet: '{}' }] }),
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
  // GUTCHECK_SHOTS_ALL=<folder>: every other view and dialog too, for reviewing the UI (not the README).
  const all = process.env.GUTCHECK_SHOTS_ALL;
  if (all) {
    const OUT2 = all;
    fs.mkdirSync(OUT2, { recursive: true });
    const shot2 = async (name, full = false) => {
      await wait(900);
      if (full) await js("document.getElementById('detail').scrollTop = 0");
      fs.writeFileSync(path.join(OUT2, name), (await win.webContents.capturePage()).toPNG());
      if (full) { await js("document.getElementById('detail').scrollTop = 99999"); await wait(300); fs.writeFileSync(path.join(OUT2, name.replace('.png', '-end.png')), (await win.webContents.capturePage()).toPNG()); await js("document.getElementById('detail').scrollTop = 0"); }
      console.log('saved', name);
    };
    const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const clickText = (sel, text) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`);
    await click('#dashboard'); await shot2('dashboard.png', true);
    await clickText('#repos li', 'recipe-api'); await shot2('repo-recipe.png', true);
    await clickText('#repos li', 'notes-sync'); await shot2('repo-notes.png', true);
    await clickText('#repos li', 'dotfiles'); await shot2('repo-dotfiles.png', true);
    await click('#overview'); await shot2('overview.png', true);
    await click('#quality'); await shot2('quality-before.png'); await clickText('#detail button', 'Scan'); await wait(2500); await shot2('quality.png', true);
    await click('#tests'); await shot2('tests-before.png'); await clickText('#detail button', 'Scan'); await wait(2500); await shot2('tests.png', true);
    await click('#clutter'); await shot2('clutter-before.png'); await clickText('#detail button', 'Scan'); await wait(2500); await shot2('clutter.png', true);
    await click('#baseline'); await shot2('baseline.png', true);
    await click('#history'); await shot2('history.png');
    await click('#background'); await shot2('settings.png');
    await clickText('.modal button', 'Connect an AI agent'); await shot2('agents.png');
    await js("document.querySelector('.overlay')?.remove()");
    await clickText('#repos li', 'recipe-api'); await wait(300);
    await clickText('.finding button', 'Ignore'); await shot2('ignore.png');
    await js("document.querySelector('.overlay')?.remove()");
    await clickText('.toolbar button', 'New branch'); await shot2('new-branch.png');
    await js("document.querySelector('.overlay')?.remove()");
  }
  fs.rmSync(demo.root, { recursive: true, force: true });
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
