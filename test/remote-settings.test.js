// Remote repos: settings are cleaned before use, and cache folder names map back to one owner/name.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { normalizeRemoteSettings, validRef } = require('../src/remote-settings');
const paths = require('../src/paths');

const env = { GUTCHECK_DATA_DIR: '/data' };

test('defaults: off, no orgs, no forks or archived, 500 MB per repo, 5 GB cache', () => {
  assert.deepEqual(normalizeRemoteSettings(undefined), { enabled: false, orgs: [], forks: false, archived: false, skip: [], maxSizeMB: 500, cacheMaxGB: 5 });
});

test('junk values are dropped or replaced by the defaults', () => {
  const s = normalizeRemoteSettings({ enabled: 'yes', orgs: ['ok-org', '--evil', 'a b', 7, 'ok-org'], skip: ['o/n', 'bad', 'o/n/x', '-x/y'], maxSizeMB: -1, cacheMaxGB: 'x', forks: true });
  assert.equal(s.enabled, false);
  assert.deepEqual(s.orgs, ['ok-org']);
  assert.deepEqual(s.skip, ['o/n']);
  assert.equal(s.maxSizeMB, 500);
  assert.equal(s.cacheMaxGB, 5);
  assert.equal(s.forks, true);
});

test('validRef: GitHub owner rules and repo name rules', () => {
  assert.ok(validRef({ owner: 'octo-cat', name: 'my.repo_x' }));
  assert.ok(!validRef({ owner: 'oc_to', name: 'x' }), 'owners have no underscore');
  assert.ok(!validRef({ owner: '-x', name: 'x' }));
  assert.ok(!validRef({ owner: 'o', name: '..' }));
  assert.ok(!validRef({ owner: 'o', name: '../x' }));
  assert.ok(!validRef(null));
});

test('cache folder names map back to one owner/name, even with __ in the name', () => {
  assert.equal(paths.remoteCacheRoot(env), path.join('/data', 'remote-cache'));
  assert.ok(paths.remoteDir('octo', 'a__b', env).endsWith(path.join('remote-cache', 'octo__a__b')));
  assert.deepEqual(paths.remoteKeyFromDir('octo__a__b'), { owner: 'octo', name: 'a__b' });
  assert.equal(paths.remoteKeyFromDir('nounderscore'), null);
  assert.equal(paths.remoteKeyFromDir('o__..'), null);
});

test('remoteDir refuses names that could leave the cache folder', () => {
  assert.throws(() => paths.remoteDir('..', 'x', env));
  assert.throws(() => paths.remoteDir('o', '../x', env));
  assert.throws(() => paths.remoteDir('o', '.', env));
});
