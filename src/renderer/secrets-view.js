// Secrets view: local secret files (.env, keys, credentials) with no backup, and the password
// manager link. Loaded after tests-view.js; shares app.js's globals ($, h, put, btn, plural, state,
// toast, onDemand, renderList), clutter-view.js's fmtSize and modals.js's (modal, askInputs,
// confirmPlans, showResults). Contents never reach this page: only paths, sizes and fingerprints.

const SEC_STATUS = { unbacked: 'not backed up', changed: 'changed since the backup', missing: 'missing from the vault', mismatch: 'differs from the vault', backed: 'backed up', skipped: 'skipped' };
const SEC_CLS = { unbacked: 'b-warn', changed: 'b-warn', missing: 'b-err', mismatch: 'b-err', backed: 'ok', skipped: '' };
const SEC_NEEDS = new Set(['unbacked', 'changed', 'missing', 'mismatch']);
// id -> [name, what its one target field means] (KeePassXC has three fields instead).
const VAULTS = { proton: ['Proton Pass', 'Vault name'], '1password': ['1Password', 'Vault name'], bitwarden: ['Bitwarden', 'Folder ID (optional)'], keepassxc: ['KeePassXC'],
  pass: ['pass', 'Subfolder (optional, default gutcheck)'], gopass: ['gopass', 'Subfolder (optional, default gutcheck)'] };
const NO_PASSWORD = 'GutCheck never asks for your master password. Unlock the password manager in its own app or terminal first.';
const secPicked = new Set(); // real paths ticked for "Back up selected" (advice picks its own)
const secName = (it) => it.title.replace(/^gutcheck: /, '');

// Same check (and message) as runActions in app.js: nothing that writes or runs a vault CLI.
function secReadOnly() {
  if (state.readOnly) toast('Read-only mode is on. Untick "Read-only" in the header to make changes.', 'bad');
  return state.readOnly;
}

function scanSecretsNow() {
  return onDemand('secrets', () => window.api.secrets.scan(), (out) => {
    state.secrets = out;
    for (const p of [...secPicked]) if (!out.items.some((i) => i.path === p && i.saveable)) secPicked.delete(p);
  });
}

// `paths` (from advice) replaces the picked files.
function openSecrets(paths) {
  state.view = 'secrets'; state.selected = null;
  if (Array.isArray(paths)) { secPicked.clear(); for (const p of paths) secPicked.add(p); }
  renderList(); renderSecrets();
  return state.secrets ? Promise.resolve() : scanSecretsNow();
}

// Plan, show exactly the command lines (and "← contents of <name> (N bytes)"), apply on confirm.
async function backupSecrets(paths) {
  if (secReadOnly()) return;
  if (!paths.length) return toast('Nothing to back up.');
  const p = await window.api.secrets.plan(paths);
  if (!p || !p.ok) return toast((p && p.error) || 'Could not plan the backup.', 'bad');
  const shown = { token: p.token, risk: p.risk, title: p.title, note: p.note, repoName: 'Secrets', warnings: [], display: (p.display || []).map((d) => ({ text: d.text })) };
  const chosen = await confirmPlans([shown]);
  if (!chosen || !chosen.length) return;
  const out = await window.api.secrets.apply(p.token);
  for (const x of paths) secPicked.delete(x);
  scanSecretsNow();
  await showResults([{ repoName: 'Secrets', ok: !!out.ok, error: out.error, results: (out.results || []).map((r) => ({ text: r.text, ok: r.ok, out: r.out })) }]);
}

async function skipSecret(it) {
  if (secReadOnly()) return;
  const v = await askInputs({ title: `Don't back up ${secName(it)}`, submit: 'Save',
    fields: [{ name: 'reason', label: 'Why not? (kept in GutCheck\'s record)', type: 'text', required: true, placeholder: 'throwaway local key' }] }, {});
  if (!v) return;
  const r = await window.api.secrets.skip(it.path, v.reason);
  if (!r.ok) return toast(r.error, 'bad');
  secPicked.delete(it.path);
  await scanSecretsNow();
}

async function unskipSecret(it) {
  if (secReadOnly()) return;
  const r = await window.api.secrets.skip(it.path, '', true);
  if (!r.ok) return toast(r.error, 'bad');
  await scanSecretsNow();
}

async function verifySecrets() {
  if (secReadOnly()) return;
  const r = await window.api.secrets.verify();
  if (!r || !r.ok) return toast((r && (r.error || r.hint)) || 'Could not check the vault.', 'bad');
  toast(`Checked ${plural(r.checked, 'item')}: ${r.missing} missing from the vault, ${r.mismatch} with a different key.`);
  await scanSecretsNow();
}

// The password manager panel. Saving stores only the tool and where items go: never a password.
async function openVaultPanel() {
  const tools = await window.api.secrets.tools();
  const cur = state.secrets && state.secrets.tool;
  const saved = (state.secrets && state.secrets.target) || null; // the linked tool's target: fills its fields, so Save/Test keep it
  return modal((box, close) => {
    let pick = (tools.find((t) => t.id === cur && t.found) || tools.find((t) => t.found) || {}).id;
    const inputs = {};
    const fields = h('div', {});
    const status = h('p', { class: 'muted', role: 'status' });
    const field = (name, label, placeholder = '') => {
      inputs[name] = h('input', { type: 'text', placeholder, spellcheck: 'false' });
      const v = pick !== cur || saved == null ? '' : name === 'target' ? saved : saved[name];
      if (typeof v === 'string') inputs[name].value = v;
      return h('label', { class: 'frow' }, h('span', {}, label), inputs[name]);
    };
    const draw = () => {
      for (const k of Object.keys(inputs)) delete inputs[k];
      if (pick === 'keepassxc') put(fields, field('db', 'Database (.kdbx), full path', '/home/me/secrets.kdbx'), field('keyFile', 'Key file, full path', '/home/me/secrets.keyx'), field('group', 'Group', 'gutcheck'));
      else put(fields, pick ? field('target', (VAULTS[pick] || [])[1] || 'Where to save') : null);
    };
    const target = () => (pick === 'keepassxc' ? { db: inputs.db.value.trim(), keyFile: inputs.keyFile.value.trim(), group: inputs.group.value.trim() } : inputs.target.value.trim());
    const radios = tools.map((t) => {
      const r = h('input', { type: 'radio', name: 'vault-tool', value: t.id });
      r.disabled = !t.found;
      r.checked = t.id === pick;
      r.addEventListener('change', () => { pick = t.id; status.textContent = ''; draw(); });
      return h('label', { class: 'frow chk' }, r, ' ', t.label, t.reason ? ` (${t.reason})` : !t.found ? ' (not found on PATH)' : '',
        t.live === false ? h('span', { class: 'badge' }, 'untested with a live vault') : null);
    });
    const save = async () => {
      if (secReadOnly()) return null;
      if (!pick) { toast('Pick a password manager.'); return null; }
      const t = target();
      const blank = pick === 'keepassxc' ? (!t.db ? 'Database path' : !t.keyFile ? 'Key file path' : '') : (pick === 'proton' || pick === '1password') && !t ? 'Vault name' : '';
      if (blank) { toast(`${blank} is required.`, 'bad'); return null; }
      const r = await window.api.secrets.link(pick, t);
      if (!r.ok) toast(r.error, 'bad');
      return r.ok;
    };
    const onSave = async () => { if (await save()) { toast(`Saved: secrets go to ${(VAULTS[pick] || [pick])[0]}.`); close(true); if (state.secrets) scanSecretsNow(); } };
    const onTest = async () => {
      if (!(await save())) return;
      status.textContent = 'Testing…';
      const r = await window.api.secrets.test();
      status.textContent = r.ok ? 'Connected: the vault is unlocked.' : `${r.locked ? 'Locked or signed out. ' : ''}${r.hint || ''}`;
    };
    draw();
    box.append(h('h3', { class: 'mh' }, 'Password manager'), h('p', { class: 'sub' }, NO_PASSWORD), h('div', { role: 'radiogroup', 'aria-label': 'Password manager' }, radios), fields, status,
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(null) }, 'Cancel'), h('button', { onclick: onTest }, 'Test connection'), h('button', { class: 'primary', onclick: onSave }, 'Save')));
  });
}

// Advice from any list. A backup step with no paths (only low-confidence files) gets no bulk button.
function secretAdviceEl(f) {
  const x = f.fix || {};
  return h('div', { class: 'finding ' + f.severity },
    h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, f.detail || '')),
    x.type === 'secret-backup' && Array.isArray(x.paths) && x.paths.length ? btn('Back up…', async () => { await openSecrets(x.paths); await backupSecrets(x.paths); }) : null,
    x.type === 'secret-link' ? btn('Password manager…', openVaultPanel) : null);
}

function secretRow(it) {
  const kind = it.kind === 'ssh' ? `SSH key${it.fingerprint ? ' ' + it.fingerprint : ''}` : it.kind;
  let cb = null;
  if (it.saveable && it.status !== 'skipped') {
    cb = h('input', { type: 'checkbox', 'aria-label': `Pick ${secName(it)}` });
    cb.checked = secPicked.has(it.path);
    cb.addEventListener('change', () => { if (cb.checked) secPicked.add(it.path); else secPicked.delete(it.path); renderSecrets(); });
  }
  return h('div', { class: 'row' }, cb,
    h('div', { class: 'grow' }, h('b', {}, secName(it)), ' ',
      h('span', { class: 'badge ' + (SEC_CLS[it.status] || '') }, SEC_STATUS[it.status] || it.status),
      it.confidence === 'low' ? h('span', { class: 'badge', title: 'In a test or fixture folder' }, 'probably a test key') : null,
      h('div', { class: 'muted' }, [kind, it.saveable ? fmtSize(it.size) : '', it.sameAs ? `same as ${it.sameAs}` : '', it.note || ''].filter(Boolean).join(' · '))),
    it.saveable && it.status !== 'skipped' && it.status !== 'backed' ? btn('Back up', () => backupSecrets([it.path])) : null,
    it.status === 'skipped' ? btn('Back up after all', () => unskipSecret(it)) : it.status !== 'backed' ? btn('Don\'t back up…', () => skipSecret(it)) : null);
}

function renderSecrets() {
  if (state.view !== 'secrets') return;
  const c = state.secrets;
  const head = [h('h2', {}, 'Secrets'),
    h('p', { class: 'sub' }, 'Local secret files (.env files, SSH and cloud keys, credentials) that exist only on this machine. Backing one up previews the exact command, then pipes the file to your password manager. GutCheck never shows or logs the contents.')];
  if (!c) {
    const err = state.scanError.secrets;
    return put($('detail'), ...head, h('p', { class: err ? 'b-err' : 'empty' }, err ? `Secrets scan failed: ${err}` : 'Scanning…'), err ? btn('Try again', () => scanSecretsNow()) : null);
  }
  const counts = {};
  for (const i of c.items) counts[i.status] = (counts[i.status] || 0) + 1;
  const all = c.items.filter((i) => i.saveable && i.confidence === 'high' && SEC_NEEDS.has(i.status)).map((i) => i.path);
  const picked = [...secPicked];
  const top = $('detail').scrollTop;
  put($('detail'), ...head,
    h('div', { class: 'toolbar' },
      Object.keys(SEC_STATUS).filter((s) => counts[s]).map((s) => h('span', { class: 'pill ' + (SEC_CLS[s] || '') }, `${counts[s]} ${SEC_STATUS[s]}`)),
      h('span', { class: 'muted' }, c.linked ? `Saving to ${(VAULTS[c.tool] || [c.tool])[0]}` : 'No password manager linked')),
    h('div', { class: 'toolbar' }, btn('Rescan', () => scanSecretsNow()),
      btn('Back up all unbacked', () => backupSecrets(all), all.length ? 'primary' : ''),
      picked.length ? btn(`Back up selected (${picked.length})…`, () => backupSecrets(picked)) : null,
      btn('Verify with vault', () => verifySecrets()), btn('Password manager…', () => openVaultPanel())),
    (c.advice || []).map(secretAdviceEl),
    c.items.length ? c.items.map(secretRow) : h('p', { class: 'ok-msg' }, 'No local secret files found.'));
  $('detail').scrollTop = top;
}

$('secrets').addEventListener('click', () => openSecrets());
