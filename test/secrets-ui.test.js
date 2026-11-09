const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, SECRETS, SECRET_ITEM } = require('./helpers/dom');

const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };
const button = (t, label, root = '#detail') => t.$$(`${root} button`).find((b) => b.textContent === label);
const modalButton = (t, label) => button(t, label, '.modal');
const callsOf = (t, name) => t.calls.filter((c) => c[0] === 'secrets.' + name);
const open = async (t) => { await scan(t); click(t.$('#secrets')); await tick(80); };

test('secrets view: counts by status, the SSH fingerprint, and the bulk buttons', async () => {
  const t = await boot();
  await open(t);
  const text = t.$('#detail').textContent;
  assert.match(text, /1 not backed up/);
  assert.match(text, /1 skipped/);
  assert.match(text, /SHA256:fpXYZ123/);
  assert.match(text, /gamma\/deploy_key/);
  for (const label of ['Back up all unbacked', 'Verify with vault', 'Password manager…']) assert.ok(button(t, label), label);
  assert.equal(t.$('#secrets').getAttribute('aria-current'), 'page');
});

test('Back up previews the plan (command lines only) and applies the token once confirmed', async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Back up'));
  await tick();
  assert.deepEqual(callsOf(t, 'plan'), [['secrets.plan', ['/w/gamma/deploy_key']]]);
  const preview = t.$('.modal').textContent;
  assert.match(preview, /← contents of deploy_key \(411 bytes\)/);
  assert.match(preview, /pass-cli item create ssh-key import/);
  assert.doesNotMatch(preview, /SHOULD-NOT-SHOW/);
  assert.equal(callsOf(t, 'apply').length, 0, 'nothing is applied before confirming');
  click(modalButton(t, 'Apply'));
  await tick(80);
  assert.deepEqual(callsOf(t, 'apply'), [['secrets.apply', 's:tok']]);
  assert.doesNotMatch(t.doc.body.textContent, /SHOULD-NOT-SHOW/);
  assert.ok(callsOf(t, 'scan').length >= 2, 'rescanned after the backup');
});

test('cancelling the preview applies nothing', async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Back up'));
  await tick();
  click(modalButton(t, 'Cancel'));
  await tick();
  assert.equal(callsOf(t, 'apply').length, 0);
});

test('read-only mode: Back up toasts the read-only message and plans nothing', async () => {
  const t = await boot();
  await open(t);
  t.run('state.readOnly = true');
  click(button(t, 'Back up'));
  await tick();
  assert.match(t.$('#toast').textContent, /Read-only mode is on/);
  assert.equal(callsOf(t, 'plan').length, 0);
  click(button(t, 'Verify with vault'));
  await tick();
  assert.equal(callsOf(t, 'verify').length, 0);
});

test('password manager panel: tools as radios, Google disabled with its reason, no password asked', async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Password manager…'));
  await tick();
  const m = t.$('.modal');
  const radios = [...m.querySelectorAll('input[type=radio]')];
  assert.deepEqual(radios.map((r) => r.value), ['proton', 'keepassxc', 'bitwarden', 'google']);
  const google = radios.find((r) => r.value === 'google');
  assert.ok(google.disabled);
  assert.match(google.closest('label').textContent, /No CLI or write API/);
  assert.ok(radios.find((r) => r.value === 'bitwarden').disabled, 'a tool not found is disabled');
  assert.match(radios.find((r) => r.value === 'keepassxc').closest('label').textContent, /untested with a live vault/);
  assert.doesNotMatch(radios.find((r) => r.value === 'proton').closest('label').textContent, /untested/);
  assert.match(m.textContent, /GutCheck never asks for your master password\. Unlock the password manager in its own app or terminal first\./);
  assert.equal(m.querySelectorAll('input[type=password]').length, 0);
  assert.ok(radios.find((r) => r.value === 'proton').checked, 'the linked tool is picked');
  assert.equal(m.querySelectorAll('input[type=text]').length, 1);
  m.querySelector('input[type=text]').value = 'Dev';
  click(modalButton(t, 'Save'));
  await tick();
  assert.deepEqual(callsOf(t, 'link'), [['secrets.link', 'proton', 'Dev']]);
});

test('password manager panel: KeePassXC takes the database, key file and group; Test connection shows the hint', async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Password manager…'));
  await tick();
  const kp = t.$$('.modal input[type=radio]').find((r) => r.value === 'keepassxc');
  kp.checked = true;
  kp.dispatchEvent(new t.w.Event('change'));
  const fields = t.$$('.modal input[type=text]');
  assert.equal(fields.length, 3);
  [fields[0].value, fields[1].value] = ['/h/v.kdbx', '/h/v.keyx'];
  click(modalButton(t, 'Test connection'));
  await tick();
  assert.deepEqual(callsOf(t, 'link'), [['secrets.link', 'keepassxc', { db: '/h/v.kdbx', keyFile: '/h/v.keyx', group: '' }]]);
  assert.equal(callsOf(t, 'test').length, 1);
  assert.match(t.$('.modal').textContent, /pass-cli login/);
});

test('Verify with vault shows the checked, missing and mismatch counts, or the error', async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Verify with vault'));
  await tick();
  assert.equal(callsOf(t, 'verify').length, 1);
  assert.match(t.$('#toast').textContent, /Checked 3 items: 1 missing from the vault, 0 with a different key/);
  const u = await boot({ secretsApi: { verify: async () => ({ ok: false, error: 'Run "pass-cli login" in a terminal, then try again.' }) } });
  await open(u);
  click(button(u, 'Verify with vault'));
  await tick();
  assert.match(u.$('#toast').textContent, /pass-cli login/);
});

test("Don't back up asks for a reason and records it; a skipped file can be backed up after all", async () => {
  const t = await boot();
  await open(t);
  click(button(t, 'Don\'t back up…'));
  await tick();
  t.$('.modal input[type=text]').value = 'throwaway key';
  click(modalButton(t, 'Save'));
  await tick(80);
  assert.deepEqual(callsOf(t, 'skip'), [['secrets.skip', '/w/gamma/deploy_key', 'throwaway key']]);
  click(button(t, 'Back up after all'));
  await tick(80);
  assert.deepEqual(callsOf(t, 'skip')[1], ['secrets.skip', '/w/gamma/old.pem', '', true]);
});

test('advice: secret-backup picks its paths, low-confidence-only advice has no bulk button, secret-link opens the panel', async () => {
  const gpg = SECRET_ITEM({ title: 'gutcheck: ~/.gnupg/private-keys-v1.d', path: '/h/.gnupg/private-keys-v1.d', scope: 'home', repo: null, rel: '.gnupg/private-keys-v1.d', status: 'unbacked', saveable: false, note: 'a folder, not one file: export with gpg --export-secret-keys yourself' });
  const advice = [
    { id: 'secret-unbacked', category: 'Secrets', severity: 'warn', title: '1 secret file exists only on this machine', detail: 'deploy_key', repo: 'gamma', fix: { type: 'secret-backup', paths: ['/w/gamma/deploy_key'] } },
    { id: 'secret-unbacked', category: 'Secrets', severity: 'info', title: 'Probably test keys', detail: 'test/fixtures/key', repo: 'beta', fix: { type: 'secret-backup', paths: [] } },
    { id: 'secret-link', category: 'Secrets', severity: 'info', title: 'No password manager linked', detail: '', fix: { type: 'secret-link' } }];
  const t = await boot({ secrets: { ...SECRETS, items: [...SECRETS.items, gpg], advice } });
  await open(t);
  const findings = t.$$('#detail .finding');
  assert.equal(findings.length, 3);
  assert.equal(findings[1].querySelectorAll('button').length, 0, 'no bulk fix for low-confidence-only advice');
  const gpgRow = t.$$('#detail .row').find((r) => r.textContent.includes('.gnupg'));
  assert.match(gpgRow.textContent, /export with gpg --export-secret-keys yourself/);
  assert.ok(![...gpgRow.querySelectorAll('button')].some((b) => b.textContent === 'Back up'), 'a folder cannot be backed up');
  click(findings[0].querySelector('button'));
  await tick();
  assert.deepEqual(callsOf(t, 'plan'), [['secrets.plan', ['/w/gamma/deploy_key']]]);
  click(modalButton(t, 'Cancel'));
  await tick();
  assert.ok(button(t, 'Back up selected (1)…'), 'the advice paths stay picked');
  click(t.$$('#detail .finding')[2].querySelector('button'));
  await tick();
  assert.equal(t.$$('.modal input[type=radio]').length, 4);
});
