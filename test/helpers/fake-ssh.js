// Remotes for action tests without a network. Actions refuse local-path and file:// remotes (a
// local remote runs that repo's own hooks), so tests use ssh://lab/<path>: GIT_SSH_COMMAND (the
// environment, the user's own setting, not repo config) runs the remote command locally, as sshd
// would on a server. Requiring this file sets it for every child git of the test process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-ssh-'));
const prog = path.join(dir, 'fake-ssh');
// git calls it as: fake-ssh [options] host "git-upload-pack '/path'"; the last argument is the command.
fs.writeFileSync(prog, '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n', { mode: 0o755 });
process.env.GIT_SSH_COMMAND = prog;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const sshUrl = (p) => `ssh://lab${path.resolve(p)}`;

module.exports = { sshUrl };
