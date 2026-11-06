// Which test stacks a repo uses, and the commands that run them with coverage or mutation testing.
// Shared by the static review (layer 1), the results reader (layer 2) and the runs (layer 3).

const fs = require('node:fs');
const path = require('node:path');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const has = (dir, ...p) => fs.existsSync(path.join(dir, ...p));

// One entry per ecosystem found at the repo root (and Rust/Node one level down, e.g. wizard/Cargo.toml).
function detectStacks(dir) {
  const out = [];
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const script = String((pkg.scripts && pkg.scripts.test) || '');
    const runner = deps.vitest || /vitest/.test(script) ? 'vitest' : deps.jest || /jest/.test(script) ? 'jest' : deps.mocha || /mocha/.test(script) ? 'mocha' : /node --test|node:test/.test(script) ? 'node' : script && !/no test specified/.test(script) ? 'npm' : null;
    out.push({ id: 'node', name: 'JavaScript/TypeScript', root: '.', runner, stryker: !!(deps['@stryker-mutator/core']), lockfile: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].find((l) => has(dir, l)) || null });
  }
  const pyText = readText(path.join(dir, 'pyproject.toml')) + readText(path.join(dir, 'requirements-dev.txt')) + readText(path.join(dir, 'requirements.txt')) + readText(path.join(dir, 'setup.cfg'));
  if (pyText || has(dir, 'setup.py') || has(dir, 'pytest.ini') || has(dir, 'tox.ini')) {
    out.push({ id: 'python', name: 'Python', root: '.', runner: /pytest/.test(pyText) || has(dir, 'pytest.ini') || has(dir, 'conftest.py') ? 'pytest' : 'unittest', venv: ['.venv', 'venv'].find((v) => has(dir, v, 'bin', 'python')) || null, pytestCov: /pytest-cov/.test(pyText) });
  }
  const cargoRoots = [];
  if (has(dir, 'Cargo.toml')) cargoRoots.push('.');
  else {
    let subs = [];
    try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch {}
    for (const s of subs) if (has(dir, s, 'Cargo.toml')) cargoRoots.push(s);
  }
  for (const r of cargoRoots.slice(0, 3)) out.push({ id: 'rust', name: 'Rust', root: r, runner: 'cargo' });
  if (has(dir, 'go.mod')) out.push({ id: 'go', name: 'Go', root: '.', runner: 'go' });
  const gradle = ['build.gradle.kts', 'build.gradle'].find((g) => has(dir, g)) || (has(dir, 'android', 'build.gradle.kts') || has(dir, 'android', 'build.gradle') ? 'android' : null);
  if (gradle) {
    const text = readText(path.join(dir, gradle)) + readText(path.join(dir, 'app', 'build.gradle.kts')) + readText(path.join(dir, 'app', 'build.gradle'));
    out.push({ id: 'gradle', name: 'Kotlin/Java (Gradle)', root: gradle === 'android' ? 'android' : '.', runner: 'gradle', kover: /kover/.test(text), jacoco: /jacoco/.test(text) });
  }
  return out;
}

// Commands that run a stack's tests in CI (matched against workflow files, read as text).
const CI_TEST_RE = {
  node: /\b(npm (run )?test|npm t\b|yarn (run )?test|pnpm (run )?test|bun test|node --test|npx (jest|vitest|mocha)|vitest|jest\b|mocha\b)/,
  python: /\b(pytest|python -m (pytest|unittest)|tox\b|nox\b|hatch (run )?test|uv run pytest|poetry run pytest)|\bpython3? \S*tests?\/\S*test\S*\.py/,
  rust: /\bcargo (test|nextest|llvm-cov|tarpaulin)\b/,
  go: /\bgo test\b/,
  gradle: /gradlew? .*\b(test|check|testDebugUnitTest|connectedCheck)\b/,
  shell: /\bbats\b|\b(?:bash|sh)\s+\S*tests?\/|\.\/tests?\/\S+\.sh|run_?tests?\.sh/,
};
const GENERIC_TEST_RE = /\b(make|just|task) (test|check)\b/;

// Install hints for the opt-in tools (never run automatically).
const INSTALL = {
  'cargo-llvm-cov': 'cargo install cargo-llvm-cov   # also: rustup component add llvm-tools-preview',
  'cargo-mutants': 'cargo install cargo-mutants',
  'pytest-cov': 'pip install pytest-cov   # into the project\'s own virtualenv',
  mutmut: 'pip install mutmut   # into the project\'s own virtualenv',
  stryker: 'npm install --save-dev @stryker-mutator/core   # then: npx stryker init',
  ruff: 'pipx install ruff   # or: pip install ruff',
};

module.exports = { detectStacks, CI_TEST_RE, GENERIC_TEST_RE, INSTALL, readJson, readText };
