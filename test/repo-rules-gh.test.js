// github.js tag-ruleset and Actions-settings reads against a fake gh on PATH (no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('fetchTagRulesets reads each active ruleset by id; failures are unknown, not empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-fakegh-'));
  const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
echo "$@" >> "${log}"
case "$2" in
  *o/denied/*) echo 'HTTP 403' >&2; exit 1;;
  *rulesets/7) echo '{"id":7,"name":"t","target":"tag","enforcement":"active","conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"}]}';;
  *o/ok/rulesets*) echo '[{"id":7,"enforcement":"active","target":"tag"},{"id":8,"enforcement":"disabled","target":"tag"}]';;
  *o/ok/actions/permissions/workflow) echo '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}';;
  *o/ok/actions/permissions) echo '{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}';;
esac
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    const gh = require('../src/github');
    const ok = await gh.fetchTagRulesets({ owner: 'o', name: 'ok' }, { force: true });
    assert.deepEqual(ok, [{ name: 't', include: ['refs/tags/v*'], exclude: [], types: ['deletion', 'non_fast_forward'] }]);
    assert.match(fs.readFileSync(log, 'utf8'), /targets=tag&includes_parents=true/);
    assert.equal(await gh.fetchTagRulesets({ owner: 'o', name: 'denied' }, { force: true }), null);
    assert.deepEqual(await gh.fetchActionsSettings({ owner: 'o', name: 'ok' }, { force: true }), { enabled: true, shaPinningRequired: false, defaultPermissions: 'write', canApprovePrs: true });
    assert.equal(await gh.fetchActionsSettings({ owner: 'o', name: 'denied' }, { force: true }), null);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
