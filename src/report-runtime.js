// Report steps for the runtime end-of-life and lockfile/manifest drift findings.
const { sq } = require('./util');
const { unsafeName } = require('./text-safe');

const REFS = {
  nodeReleases: 'https://nodejs.org/en/about/previous-releases',
  pythonVersions: 'https://devguide.python.org/versions/',
  goRelease: 'https://go.dev/doc/devel/release',
  npmInstall: 'https://docs.npmjs.com/cli/v10/commands/npm-install#package-lock-only',
  cargoFaq: 'https://doc.rust-lang.org/cargo/faq.html',
};
const NPM_LOCK = 'npm install --package-lock-only --ignore-scripts';

function runtimeFix(id, r) {
  const uses = (r.runtimes && r.runtimes.uses) || [];
  const files = [...new Set(uses.map((u) => u.file))].filter((f) => !unsafeName(f));
  const products = new Set(uses.map((u) => u.product));
  const ref = products.has('node') ? REFS.nodeReleases : products.has('python') ? REFS.pythonVersions : REFS.goRelease;
  if (id === 'runtime-eol' || id === 'runtime-eol-soon') {
    return {
      phase: 4, rank: id === 'runtime-eol' ? 8 : 9,
      why: id === 'runtime-eol' ? 'A runtime version the project pins or tests in CI no longer gets security fixes.' : 'A runtime version the project pins or tests in CI loses support within 90 days.',
      cmds: files.map((f) => `grep -nEi 'node|python|go|toolchain|requires|^v?[0-9]' ${sq(f)}   # the version to change`),
      note: 'Move the pin and the CI versions to a line the finding lists as still supported, run the tests on it, and change them together (they should name the same version). Do not raise a range or matrix to a version the project has not been tried on, and do not change a pin without the owner agreeing; GutCheck never edits these files by itself. A "go" line in go.mod is only a minimum: leave it unless the code needs the newer language version.',
      ref,
    };
  }
  if (id === 'lockfile-drift') return { phase: 4, rank: 1, why: 'The lockfile no longer describes package.json, so `npm ci` can refuse to install.', cmds: [NPM_LOCK, 'git diff --stat package-lock.json   # expect only the root entry and the changed dependencies', 'git add package-lock.json && git commit -m "Sync package-lock.json with package.json"'], note: 'This rewrites only the lockfile: --package-lock-only leaves node_modules alone and --ignore-scripts runs no project scripts. It needs the registry for new or changed dependencies. If the diff shows many unrelated version changes, stop and ask the owner.', ref: REFS.npmInstall };
  if (id === 'version-drift') return { phase: 4, rank: 10, why: 'One project reports different versions depending on the file.', cmds: ['grep -n \'"version"\' package.json src-tauri/tauri.conf.json 2>/dev/null', 'grep -n \'^version\' Cargo.toml src-tauri/Cargo.toml pyproject.toml 2>/dev/null', `# afterwards, refresh lockfiles: ${NPM_LOCK}   and   cargo update --workspace`], note: 'Ask the owner which version is current (usually the newest release tag), set every file to it, and refresh the lockfiles that record it. In a Tauri 2 config, "version" may instead point at package.json ("../package.json"), which keeps the two in step by itself; Cargo.toml can inherit with `version.workspace = true`.' };
  if (id === 'cargo-lock-untracked') return { phase: 4, rank: 11, why: 'The binary crate\'s dependency versions are not recorded in git.', cmds: ['git check-ignore -v Cargo.lock src-tauri/Cargo.lock   # which rule hides it', '# remove that line from .gitignore, then:', 'git add Cargo.lock && git commit -m "Track Cargo.lock"'], note: 'For a binary the lockfile gives reproducible builds, and CI sees the same versions you do. The Cargo FAQ leaves the choice to the project, so ask the owner if the ignore looks deliberate.', ref: REFS.cargoFaq };
  return null;
}

module.exports = { runtimeFix, REFS };
