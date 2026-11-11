// uQ's theme: the main-process reader and watch (src/uq-theme.js) and the renderer side
// (src/renderer/uq-theme.mjs + the vendored uq-tokens), with a fake window and root element.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uqDir, readTokens, watchTheme, MAX_BYTES } = require('../src/uq-theme');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const renderer = () => import('../src/renderer/uq-theme.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-uq-'));

function fakeRoot() {
  const props = new Map();
  const attrs = new Map();
  return {
    props, attrs,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k),
  };
}

// A fake preload bridge (window.uqTokens) serving shell.text; shell.fire() is uqd's change.
function fakeWindow(text) {
  const shell = { text, fire: () => {}, unsubscribed: false };
  shell.win = { uqTokens: {
    read: async () => shell.text,
    subscribe: (cb) => { shell.fire = cb; return () => { shell.unsubscribed = true; }; },
  } };
  return shell;
}

const tokens = (colors, extra = {}) => JSON.stringify({ variant: 'dark', colors, ui: { radius: 6 }, fonts: { ui: 'Inter' }, ...extra });

test('uqDir: an absolute XDG_STATE_HOME, else ~/.local/state', () => {
  assert.equal(uqDir({ XDG_STATE_HOME: '/s' }, '/home/me'), path.join('/s', 'uq'));
  assert.equal(uqDir({ XDG_STATE_HOME: 'rel/state' }, '/home/me'), path.join('/home/me', '.local', 'state', 'uq'));
  assert.equal(uqDir({}, '/home/me'), path.join('/home/me', '.local', 'state', 'uq'));
});

test('readTokens: the file text, or null when missing, a folder or too large', () => {
  const dir = tmp();
  assert.equal(readTokens(dir), null);
  fs.mkdirSync(path.join(dir, 'theme', 'tokens.json'), { recursive: true });
  assert.equal(readTokens(dir), null, 'a folder is not the file');
  fs.rmSync(path.join(dir, 'theme'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'tokens.json'), '{"variant":"dark"}');
  assert.equal(readTokens(dir), '{"variant":"dark"}');
  fs.writeFileSync(path.join(dir, 'theme', 'tokens.json'), ' '.repeat(MAX_BYTES));
  assert.equal(readTokens(dir), null);
  fs.rmSync(dir, { recursive: true });
});

test('watchTheme: fires when theme/ is swapped atomically; null without uQ', async () => {
  assert.equal(watchTheme(path.join(tmp(), 'missing'), () => {}), null);
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'theme'));
  let fired = 0;
  const w = watchTheme(dir, () => { fired++; });
  assert.ok(w);
  fs.writeFileSync(path.join(dir, 'other'), 'x');
  fs.mkdirSync(path.join(dir, 'theme.new'));
  fs.writeFileSync(path.join(dir, 'theme.new', 'tokens.json'), '{}');
  fs.rmSync(path.join(dir, 'theme'), { recursive: true });
  fs.renameSync(path.join(dir, 'theme.new'), path.join(dir, 'theme'));
  for (let i = 0; i < 50 && !fired; i++) await new Promise((r) => setTimeout(r, 20));
  w.close();
  assert.ok(fired > 0);
  fs.rmSync(dir, { recursive: true });
});

test('renderer: applies uQ tokens to <html> and follows changes', async () => {
  const { startUqTheme } = await renderer();
  const shell = fakeWindow(tokens({ bg: '#101010', text: '#fafafa' }));
  const root = fakeRoot();
  const watch = startUqTheme(shell.win, root);
  await watch.ready;
  assert.equal(root.props.get('--uq-bg'), '#101010');
  assert.equal(root.props.get('--uq-text'), '#fafafa');
  assert.equal(root.props.get('--uq-radius'), '6px');
  assert.equal(root.props.get('--uq-font-ui'), '"Inter"');
  assert.equal(root.attrs.get('data-uq-variant'), 'dark');

  shell.text = tokens({ bg: '#fdfdfd' }, { variant: 'light' });
  shell.fire();
  await watch.refresh();
  assert.equal(root.props.get('--uq-bg'), '#fdfdfd');
  assert.equal(root.props.has('--uq-text'), false, 'nothing stale stays');
  assert.equal(root.attrs.get('data-uq-variant'), 'light');
  watch.stop();
  assert.equal(shell.unsubscribed, true);
});

test('renderer: a missing or broken file falls back to GutCheck\'s own colours', async () => {
  const { startUqTheme } = await renderer();
  const shell = fakeWindow(tokens({ bg: '#101010' }));
  const root = fakeRoot();
  const watch = startUqTheme(shell.win, root);
  await watch.ready;
  assert.equal(root.attrs.has('data-uq-variant'), true);
  shell.text = null;
  await watch.refresh();
  assert.equal(root.props.size, 0);
  assert.equal(root.attrs.has('data-uq-variant'), false);
  shell.text = '{"colors": ';
  await watch.refresh();
  assert.equal(root.props.size, 0);
  watch.stop();
  assert.equal(startUqTheme({}, fakeRoot()), null, 'no bridge (not the app): nothing to do');
});

test('renderer: an injection attempt is rejected, valid values kept', async () => {
  const { startUqTheme } = await renderer();
  const shell = fakeWindow(JSON.stringify({
    variant: 'dark;}body{display:none',
    colors: { bg: 'red;}body{display:none', text: '#fafafa' },
    fonts: { ui: 'x";}body{background:url(//evil)}', mono: 'url(//evil)' },
    ui: { radius: '1px;}' },
  }));
  const root = fakeRoot();
  const watch = startUqTheme(shell.win, root);
  await watch.ready;
  assert.deepEqual([...root.props], [['--uq-text', '#fafafa']]);
  assert.equal(root.attrs.has('data-uq-variant'), false);
  watch.stop();
});

test('the page loads the vendored module and maps uQ onto GutCheck\'s colours', async () => {
  const { VERSION } = await import('../src/vendor/uq-tokens/uq-tokens.js');
  assert.equal(VERSION, '1.0.0');
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  for (const ref of ['../vendor/uq-tokens/uq-tokens.css', 'uq-theme.css', 'uq-theme.mjs']) {
    assert.ok(html.includes(`"${ref}"`), ref);
    assert.ok(fs.existsSync(path.join(RENDERER, ref)), ref);
  }
  const css = fs.readFileSync(path.join(RENDERER, 'uq-theme.css'), 'utf8');
  for (const m of ['--bg: var(--uq-bg)', '--text: var(--uq-text)', '--accent: var(--uq-accent)', '--err: var(--uq-error)']) assert.ok(css.includes(m), m);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'), /exposeInMainWorld\('uqTokens'/);
});
