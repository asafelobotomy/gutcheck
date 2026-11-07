// Layer 3: run a repo's tests with coverage, or mutation testing, as an action. Unlike every scan,
// this executes the project's own code, so it is opt-in per repo, planned and previewed like any
// other change, and marked dangerous (the user types the repo name). Output goes to GutCheck's run
// folder, not the repo, wherever the tool allows it. Tools are never installed automatically: a
// missing one fails the plan with the command to install it.

const path = require('node:path');
const { runDir } = require('../paths');
const fs = require('node:fs');
const os = require('node:os');
const { INSTALL } = require('./stack');

const COVERAGE_TIMEOUT_MS = 30 * 60 * 1000;
const MUTATION_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Planning must not execute the repo's code (only the approved apply step does). So a tool check runs
// only the user's own binaries, from a neutral folder: cargo then reads no repo .cargo/config, and
// python puts no repo module (a planted pytest.py) on sys.path. Repo-supplied binaries (a virtualenv's
// python, node_modules/.bin) are looked up on disk, never run.
const ok = async (ctx, cmd, args) => (await ctx.run(cmd, args, { cwd: os.tmpdir(), timeout: 60000 })).ok;
const FIND_SPEC = 'import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in sys.argv[1:]) else 1)';
// Python modules: in a virtualenv, by their folder or file in site-packages; else ask the user's python3.
async function hasPyModules(ctx, dir, s, mods) {
  if (!s.venv) return ok(ctx, 'python3', ['-c', FIND_SPEC, ...mods]);
  const venv = path.join(dir, s.venv);
  const sites = [path.join(venv, 'Lib', 'site-packages')];
  try { for (const n of fs.readdirSync(path.join(venv, 'lib'))) if (/^python\d/.test(n)) sites.push(path.join(venv, 'lib', n, 'site-packages')); } catch {}
  return mods.every((m) => sites.some((sp) => fs.existsSync(path.join(sp, m)) || fs.existsSync(path.join(sp, m + '.py'))));
}
// A file under node_modules, from the test root up to the repo root (where npm and npx would find it).
function inNodeModules(cwd, top, rel) {
  for (let d = cwd; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules', rel))) return true;
    if (d === top || path.dirname(d) === d || !d.startsWith(top)) return false;
  }
}
const pythonOf = (dir, s) => (s.venv ? path.join(dir, s.venv, 'bin', 'python') : 'python3');
const cmd = (cmd, args, cwd, display, extra = {}) => ({ kind: 'cmd', cmd, args, cwd, display, ...extra });

// Each returns { steps, note } or throws Error(message) when the tool is missing or unsupported.
const PLANS = {
  coverage: {
    async rust(r, s, ctx, out, cwd) {
      if (!(await ok(ctx, 'cargo', ['llvm-cov', '--version']))) throw new Error(`cargo-llvm-cov is not installed. Install it with:\n${INSTALL['cargo-llvm-cov']}`);
      const lcov = path.join(out, 'lcov.info');
      return { steps: [cmd('cargo', ['llvm-cov', '--workspace', '--lcov', '--output-path', lcov], cwd, `cargo llvm-cov --workspace --lcov --output-path ${lcov}`, { timeout: COVERAGE_TIMEOUT_MS })], note: 'Builds the project with coverage instrumentation, then runs every test.' };
    },
    async python(r, s, ctx, out, cwd) {
      const py = pythonOf(r.path, s);
      if (!(await hasPyModules(ctx, r.path, s, ['pytest', 'pytest_cov']))) throw new Error(`pytest and pytest-cov are needed in ${s.venv ? `the ${s.venv} virtualenv` : 'your Python'}. Install with:\n${INSTALL['pytest-cov']}`);
      const xml = path.join(out, 'coverage.xml');
      const junit = path.join(out, 'junit.xml');
      return { steps: [cmd(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--cov=.', `--cov-report=xml:${xml}`, `--junitxml=${junit}`], cwd, `${s.venv ? s.venv + '/bin/python' : 'python3'} -m pytest -q -p no:cacheprovider --cov=. --cov-report=xml:${xml} --junitxml=${junit}`, { timeout: COVERAGE_TIMEOUT_MS, env: { COVERAGE_FILE: path.join(out, '.coverage') } })], note: 'Runs pytest with coverage. The coverage data file goes to GutCheck\'s run folder too.' };
    },
    async node(r, s, ctx, out, cwd) {
      const lcov = path.join(out, 'lcov.info');
      if (s.runner === 'node') return { steps: [cmd('node', ['--test', '--experimental-test-coverage', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, '--test-reporter=junit', `--test-reporter-destination=${path.join(out, 'junit.xml')}`], cwd, `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=${lcov} (+ spec and JUnit reporters)`, { timeout: COVERAGE_TIMEOUT_MS })], note: 'Runs the built-in Node test runner with its own coverage.' };
      if (s.runner === 'jest') return { steps: [cmd('npx', ['--no-install', 'jest', '--coverage', '--coverageReporters=lcov', `--coverageDirectory=${out}`], cwd, `npx --no-install jest --coverage --coverageReporters=lcov --coverageDirectory=${out}`, { timeout: COVERAGE_TIMEOUT_MS })] };
      if (s.runner === 'vitest') {
        if (!inNodeModules(cwd, r.path, path.join('@vitest', 'coverage-v8', 'package.json'))) throw new Error('vitest needs a coverage provider. Install with:\nnpm install --save-dev @vitest/coverage-v8');
        return { steps: [cmd('npx', ['--no-install', 'vitest', 'run', '--coverage', '--coverage.reporter=lcov', `--coverage.reportsDirectory=${out}`], cwd, `npx --no-install vitest run --coverage --coverage.reporter=lcov --coverage.reportsDirectory=${out}`, { timeout: COVERAGE_TIMEOUT_MS })] };
      }
      if (!inNodeModules(cwd, r.path, path.join('.bin', 'c8')) && !onPath('c8')) throw new Error('This test command has no coverage option GutCheck knows. Install c8 to measure it:\nnpm install --save-dev c8');
      return { steps: [cmd('npx', ['--no-install', 'c8', '--reporter=lcovonly', `--report-dir=${out}`, 'npm', 'test'], cwd, `npx --no-install c8 --reporter=lcovonly --report-dir=${out} npm test`, { timeout: COVERAGE_TIMEOUT_MS })] };
    },
    async go(r, s, ctx, out, cwd) {
      const prof = path.join(out, 'cover.out');
      return { steps: [cmd('go', ['test', './...', `-coverprofile=${prof}`], cwd, `go test ./... -coverprofile=${prof}`, { timeout: COVERAGE_TIMEOUT_MS })] };
    },
  },
  mutation: {
    async rust(r, s, ctx, out, cwd) {
      if (!(await ok(ctx, 'cargo', ['mutants', '--version']))) throw new Error(`cargo-mutants is not installed. Install it with:\n${INSTALL['cargo-mutants']}`);
      return { steps: [cmd('cargo', ['mutants', '--output', out, '--timeout-multiplier', '3', '--no-shuffle'], cwd, `cargo mutants --output ${out} --timeout-multiplier 3`, { timeout: MUTATION_TIMEOUT_MS })], note: 'Changes the code one small bit at a time (in a copy) and runs the tests after each change. Can take a long time.' };
    },
    async python(r, s, ctx, out, cwd) {
      const py = pythonOf(r.path, s);
      if (!(await hasPyModules(ctx, r.path, s, ['mutmut']))) throw new Error(`mutmut is not installed in ${s.venv ? `the ${s.venv} virtualenv` : 'your Python'}. Install with:\n${INSTALL.mutmut}`);
      return { steps: [
        cmd(py, ['-m', 'mutmut', 'run'], cwd, `${s.venv ? s.venv + '/bin/python' : 'python3'} -m mutmut run`, { timeout: MUTATION_TIMEOUT_MS, okCodes: [0, 1, 2] }),
        cmd(py, ['-m', 'mutmut', 'results'], cwd, `${s.venv ? s.venv + '/bin/python' : 'python3'} -m mutmut results > ${path.join(out, 'mutmut-results.txt')}`, { saveOutput: path.join(out, 'mutmut-results.txt') }),
      ], note: 'mutmut keeps its working copies in a mutants/ folder inside the repo (add it to .gitignore).' };
    },
    async node(r, s, ctx, out, cwd) {
      if (!s.stryker) throw new Error(`Stryker is not set up in this project. Install it with:\n${INSTALL.stryker}`);
      return { steps: [cmd('npx', ['--no-install', 'stryker', 'run', '--reporters', 'json,clear-text,progress'], cwd, 'npx --no-install stryker run --reporters json,clear-text,progress', { timeout: MUTATION_TIMEOUT_MS })], note: 'Stryker writes reports/mutation/mutation.json inside the repo.' };
    },
  },
};

// Planned like any action: actions.js calls this for the 'tests-run' action.
async function planTestRun(r, p, ctx) {
  const kind = p.kind === 'mutation' ? 'mutation' : p.kind === 'coverage' ? 'coverage' : null;
  if (!kind) throw new Error('Choose coverage or mutation.');
  const stacks = (await require('./review').reviewTests(r.path)).stacks; // includes stacks known only from their tests
  const s = (p.stack ? stacks.find((x) => x.id === p.stack && (!p.root || x.root === p.root)) : stacks.find((x) => PLANS[kind][x.id])) || null;
  if (!s) throw new Error(stacks.length ? `GutCheck cannot run ${kind} for ${stacks.map((x) => x.name).join(', ')} yet.` : 'No test setup found in this repo.');
  if (!PLANS[kind][s.id]) throw new Error(`GutCheck cannot run ${kind} for ${s.name} yet.`);
  const out = (ctx.runDir || runDir)(r.path);
  const cwd = path.join(r.path, s.root);
  const plan = await PLANS[kind][s.id](r, s, ctx, out, cwd);
  return {
    risk: 'danger',
    title: `Run ${kind === 'coverage' ? 'tests with coverage' : 'mutation testing'} (${s.name}${s.root !== '.' ? `, ${s.root}` : ''})`,
    steps: [{ kind: 'mkdir', path: out, display: `create GutCheck's run folder ${out}` }, ...plan.steps],
    warnings: [`This runs the project's own tests and build scripts, which execute its code with your permissions. Only run it on repos you trust.${kind === 'mutation' ? ' Mutation testing can take from minutes to hours.' : ''}`],
    note: plan.note || null,
    undo: `Results are in ${out}; delete that folder to remove them.`,
  };
}

// Binaries each kind needs (not run: a PATH lookup only, so scanning never executes anything of the repo's).
const TOOLS = { coverage: { rust: 'cargo-llvm-cov', python: null, node: null, go: null }, mutation: { rust: 'cargo-mutants', python: null, node: null } };
const onPath = (bin) => !bin || (process.env.PATH || '').split(path.delimiter).some((d) => d && (() => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } })());
// mutation for Node needs Stryker in the project; python needs mutmut/pytest-cov in its virtualenv (checked at plan time).
const runnable = (stacks) => stacks.map((s) => ({
  stack: s.id, root: s.root, name: s.name,
  coverage: !!PLANS.coverage[s.id], mutation: !!PLANS.mutation[s.id] && (s.id !== 'node' || !!s.stryker),
  missing: [['coverage', TOOLS.coverage[s.id]], ['mutation', TOOLS.mutation[s.id]]].filter(([, bin]) => bin && !onPath(bin)).map(([kind, bin]) => ({ kind, bin, install: INSTALL[bin] })),
}));

module.exports = { planTestRun, runnable, COVERAGE_TIMEOUT_MS, MUTATION_TIMEOUT_MS };
