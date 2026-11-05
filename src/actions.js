const fs = require('node:fs');
const path = require('node:path');
const { run, gitWrite } = require('./exec');

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

const TEMPLATES = {
  mit: (author) => `MIT License

Copyright (c) ${new Date().getFullYear()} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  readme: (_a, name) => `# ${name}\n\nTODO: describe the project, how to install it and how to run it.\n`,
  gitignore: () => 'node_modules/\ndist/\nbuild/\n.env\n*.log\n.DS_Store\n',
};

// Which actions need an explicit confirmation dialog (shown by main process).
const NEEDS_CONFIRM = new Set(['merge-pr', 'delete-merged', 'push', 'create-file', 'npm-install']);

function describe(a, repoName) {
  switch (a.type) {
    case 'merge-pr': return `Squash-merge PR #${a.number} in ${repoName} and delete its branch on GitHub?`;
    case 'delete-merged': return `Delete ${a.branches.length} merged local branch(es) in ${repoName}?\n\n${a.branches.join('\n')}`;
    case 'push': return `Push the current branch of ${repoName} to its upstream?`;
    case 'create-file': return `Create ${a.file} in ${repoName}? (Nothing is committed.)`;
    case 'npm-install': return `Run npm install in ${repoName}?\n\nThis executes the project's package install scripts.`;
    default: return `Run ${a.type} on ${repoName}?`;
  }
}

// Execute a validated action. `dir` must already be verified as a known repo by the caller.
async function execute(dir, repo, a) {
  const slug = repo && repo.remote ? `${repo.remote.owner}/${repo.remote.name}` : null;
  switch (a.type) {
    case 'fetch':
      return gitWrite(['fetch', '--all', '--prune'], { cwd: dir, timeout: 60000 });
    case 'pull':
      return gitWrite(['pull', '--ff-only'], { cwd: dir, timeout: 60000 });
    case 'push':
      return gitWrite(['push'], { cwd: dir, timeout: 60000 });
    case 'rerun-failed': {
      if (!slug || !(repo.ci?.failed || []).some((r) => r.databaseId === a.runId)) return bad('run is not a known failed run');
      return run('gh', ['run', 'rerun', String(a.runId), '--failed', '-R', slug], { cwd: dir });
    }
    case 'merge-pr': {
      if (!slug || !(repo.prs || []).some((p) => p.number === a.number)) return bad('PR is not a known open PR');
      return run('gh', ['pr', 'merge', String(a.number), '--squash', '--delete-branch', '-R', slug], { cwd: dir, timeout: 60000 });
    }
    case 'delete-merged': {
      const names = Array.isArray(a.branches) ? a.branches : [];
      const merged = repo.git?.mergedBranches || [];
      if (!names.length || !names.every((b) => BRANCH_RE.test(b) && !b.startsWith('-') && merged.includes(b))) return bad('branch list does not match the scanned merged branches');
      // -d (not -D): git itself refuses to delete anything not fully merged.
      return gitWrite(['branch', '-d', '--', ...names], { cwd: dir });
    }
    case 'npm-install':
      return run('npm', ['install'], { cwd: dir, timeout: 300000 });
    case 'create-file': {
      const tpl = TEMPLATES[a.template];
      if (!tpl || !['LICENSE', 'README.md', '.gitignore'].includes(a.file)) return bad('invalid template');
      const target = path.join(dir, a.file);
      if (fs.existsSync(target)) return bad(a.file + ' already exists');
      const who = (await run('git', ['config', 'user.name'], { cwd: dir })).stdout.trim() || 'Author';
      fs.writeFileSync(target, tpl(who, path.basename(dir)), { flag: 'wx' });
      return { ok: true, stdout: 'Created ' + a.file, stderr: '' };
    }
    default:
      return bad('unknown action: ' + a.type);
  }
}

const bad = (msg) => ({ ok: false, stdout: '', stderr: msg });

module.exports = { execute, describe, NEEDS_CONFIRM };
