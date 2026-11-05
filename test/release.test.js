const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const wf = read('.github/workflows/build.yml');
const releaseJob = wf.slice(wf.indexOf('\n  release:'));

test('package.json and package-lock.json agree on the version (a bump must touch both)', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('CI releases on a version bump to main and on v* tags, only after tests and the build pass', () => {
  assert.match(wf, /branches: \[main\]/);
  assert.match(wf, /tags: \['v\*'\]/);
  assert.match(releaseJob, /needs: appimage/);
  assert.match(wf, /appimage:\n {4}needs: test/);
  assert.match(releaseJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(releaseJob, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(releaseJob, /github\.event_name == 'push'/, 'pull requests must never publish');
});

test('the release is created from package.json version, once, with the built files and checksums', () => {
  assert.match(wf, /require\('\.\/package\.json'\)\.version/);
  assert.match(releaseJob, /TAG="v\$VERSION"/);
  assert.match(releaseJob, /gh release view "\$TAG"/, 'skips when the release already exists');
  assert.match(releaseJob, /git\/ref\/tags\/\$TAG/, 'does not re-release a version whose tag is taken');
  assert.match(releaseJob, /gh release create "\$TAG" dist\/\*\.AppImage dist\/SHA256SUMS\.txt/);
  assert.match(releaseJob, /--target "\$GITHUB_SHA"/);
  assert.match(releaseJob, /--prerelease/);
});

test('a pushed tag must match package.json, otherwise the build fails', () => {
  assert.match(wf, /\$GITHUB_REF_NAME" != "v\$VERSION"/);
  assert.match(wf, /exit 1/);
});

test('release permissions stay minimal and actions stay pinned to SHAs', () => {
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.equal((releaseJob.match(/contents: write/g) || []).length, 1);
  assert.equal((wf.match(/contents: write/g) || []).length, 1, 'only the release job may write');
  for (const line of wf.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l))) assert.match(line, /@[0-9a-f]{40}\b/, line);
  assert.match(releaseJob, /concurrency:\n {6}group: release\n {6}cancel-in-progress: false/, 'releases are serialised, never cancelled half way');
});
