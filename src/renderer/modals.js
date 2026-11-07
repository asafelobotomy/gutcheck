// Modal dialogs: input forms, the exact-commands review, and results. Loaded after app.js and shares
// its globals ($, h, state). runActions() in app.js drives these.

/* ---------------------------------------------------------------- modals */

// Escape cancels; Tab stays inside the dialog; focus goes back to whatever opened it.
function modal(build) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const close = (v) => { overlay.remove(); if (opener && opener.focus) opener.focus(); resolve(v); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const overlay = h('div', { class: 'overlay' }, box);
    build(box, close);
    const title = box.querySelector('.mh');
    if (title) { title.id = 'modal-title'; box.setAttribute('aria-labelledby', 'modal-title'); }
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') return;
      const f = [...box.querySelectorAll('button,input,select,summary,[tabindex]')].filter((el) => !el.disabled);
      if (!f.length) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(overlay);
    const first = box.querySelector('input,select,button.primary') || box.querySelector('button');
    if (first) first.focus();
  });
}

// Fields the user fills in before an action is planned. The main process validates everything again.
const INPUTS = {
  'create-branch': { title: 'New branch', fields: [{ name: 'name', label: 'Branch name', type: 'text', required: true, placeholder: 'feature/my-change' }] },
  'commit-all': { title: 'Commit all changes', fields: [{ name: 'message', label: 'Commit message', type: 'text', required: true }] },
  'repo-edit': { title: 'Edit repository settings', fields: [{ name: 'description', label: 'Description', type: 'text' }, { name: 'deleteBranchOnMerge', label: 'Automatically delete branches after they are merged', type: 'checkbox' }] },
  'pr-merge': { title: 'Merge pull request', fields: [{ name: 'method', label: 'Method', type: 'select', options: [['squash', 'Squash and merge'], ['merge', 'Merge commit'], ['rebase', 'Rebase and merge']] }, { name: 'deleteBranch', label: 'Delete the branch afterwards', type: 'checkbox' }] },
  'pr-create': { title: 'Open pull request', fields: [{ name: 'title', label: 'Title (leave empty to use the commit messages)', type: 'text' }] },
  'protect-branch': { title: 'Protect default branch', fields: [{ name: 'preset', label: 'Preset', type: 'select', options: [['minimal', 'Minimal: no force-push or deletion, direct pushes still allowed'], ['basic', 'Basic: PR required, no force-push or deletion'], ['strict', 'Strict: also 1 approval, admins included']] }] },
  'merge-branch': { title: 'Merge into current branch', fields: [{ name: 'mode', label: 'Mode', type: 'select', options: [['ff', 'Fast-forward only'], ['no-ff', 'Always create a merge commit']] }] },
  'add-file': { title: 'Add file', fields: [{ name: 'commit', label: 'Also commit the new file', type: 'checkbox' }] },
};

function askInputs(spec, values) {
  return modal((box, close) => {
    const inputs = {};
    const rows = spec.fields.map((f) => {
      let el;
      if (f.type === 'select') el = h('select', {}, f.options.map(([v, l]) => h('option', { value: v }, l)));
      else if (f.type === 'checkbox') el = h('input', { type: 'checkbox' });
      else el = h('input', { type: 'text', placeholder: f.placeholder || '', spellcheck: 'false' });
      const v = values[f.name];
      if (f.type === 'checkbox') el.checked = !!v;
      else if (v != null) el.value = v;
      inputs[f.name] = el;
      return f.type === 'checkbox' ? h('label', { class: 'frow chk' }, el, ' ', f.label) : h('label', { class: 'frow' }, h('span', {}, f.label), el);
    });
    const submit = () => {
      const out = {};
      for (const f of spec.fields) {
        const el = inputs[f.name];
        out[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
        if (f.required && !out[f.name]) { el.focus(); return; }
      }
      close(out);
    };
    box.addEventListener('keydown', (e) => e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text' && submit());
    const extra = spec.extra ? spec.extra(close) : [];
    box.append(h('h3', { class: 'mh' }, spec.title), ...(spec.lead || []).map((t) => h('h4', {}, t)), ...rows, ...extra,
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(null) }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, spec.submit || 'Continue')));
  });
}

// The names typed for each confirmed list of plans: { token: repo name }, for applyActions.
const planConfirm = new WeakMap();
const confirmOf = (chosen) => planConfirm.get(chosen) || {};

const RISK_LABEL = { safe: 'Safe', caution: 'Changes things', danger: 'Dangerous' };

// Show the exact plan. Resolves to true if the user confirms.
// Resolves to the plans to run (in order), or null. With several plans each has a tick box, so any
// one can be left out. opts.lead: lines shown above the list (what was left out, and why).
// Each repo with a dangerous plan needs its name typed; the names go with the plans to the main
// process (planConfirm), which refuses a dangerous plan without its repo's name.
function confirmPlans(plans, { lead = [] } = {}) {
  const danger = plans.some((p) => p.risk === 'danger');
  const names = [...new Set(plans.map((p) => p.confirmName).filter(Boolean))];
  const many = plans.length > 1;
  const picked = new Set(plans);
  return modal((box, close) => {
    const label = () => (many ? `Apply ${picked.size} change${picked.size === 1 ? '' : 's'}` : 'Apply');
    const ok = h('button', { class: danger ? 'danger' : 'primary' }, label());
    const typed = new Map(names.map((n) => [n, h('input', { type: 'text', placeholder: n, spellcheck: 'false', 'aria-label': `Type ${n} to confirm` })]));
    // Only the repos of plans still ticked need their name.
    const ready = () => picked.size && [...picked].every((p) => !p.confirmName || typed.get(p.confirmName).value === p.confirmName);
    const update = () => { ok.textContent = label(); ok.disabled = !ready(); };
    for (const el of typed.values()) el.addEventListener('input', update);
    ok.disabled = !ready();
    ok.addEventListener('click', () => {
      const chosen = plans.filter((p) => picked.has(p));
      planConfirm.set(chosen, Object.fromEntries(chosen.filter((p) => p.confirmName).map((p) => [p.token, typed.get(p.confirmName).value])));
      close(chosen);
    });
    const tick = (p) => {
      if (!many) return null;
      const c = h('input', { type: 'checkbox', 'aria-label': `Include: ${p.title}` });
      c.checked = true;
      c.addEventListener('change', () => { if (c.checked) picked.add(p); else picked.delete(p); update(); });
      return c;
    };
    box.classList.add('wide');
    box.append(
      h('h3', { class: 'mh' }, many ? `Review ${plans.length} changes` : 'Review change'),
      h('p', { class: 'sub' }, many ? 'These exact commands will run, in this order, and nothing else. Untick any you do not want.' : 'These exact commands will run, and nothing else.'),
      ...lead.map((l) => h('p', { class: 'muted lead' }, l)),
      h('div', { class: 'plans' }, plans.map((p, i) => h('div', { class: 'plan ' + p.risk },
        h('div', { class: 'phead' }, tick(p), h('b', {}, many ? `${i + 1}. ${p.repoName}` : p.repoName), h('span', { class: 'risk r-' + p.risk }, RISK_LABEL[p.risk])),
        h('div', {}, p.title),
        p.note ? h('div', { class: 'muted' }, p.note) : null,
        ...p.warnings.map((w) => h('pre', { class: 'warnbox' }, w)),
        ...p.display.map((d) => h('div', {}, h('code', {}, d.text), d.preview ? h('pre', { class: 'prev' }, d.preview) : null)),
        p.body ? h('details', {}, h('summary', {}, 'Request body'), h('pre', { class: 'prev' }, p.body)) : null,
        p.undo ? h('div', { class: 'muted' }, 'To undo: ', h('code', {}, p.undo)) : null))),
      ...[...typed].map(([n, el]) => h('label', { class: 'frow' }, h('span', {}, `Type "${n}" to confirm`), el)),
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(false) }, 'Cancel'), ok));
  });
}

function showResults(outs) {
  return modal((box, close) => {
    box.classList.add('wide');
    box.append(h('h3', { class: 'mh' }, outs.every((o) => o.ok) ? 'Done' : 'Finished with errors'),
      h('div', { class: 'plans' }, outs.map((o) => h('div', { class: 'plan ' + (o.ok ? 'safe' : 'danger') },
        h('b', {}, `${o.repoName || ''}  ${o.ok ? '✓' : '✗'}`),
        o.error ? h('div', { class: 'b-err' }, o.error) : null,
        ...(o.results || []).map((r) => h('div', {}, h('code', {}, (r.ok ? '✓ ' : '✗ ') + r.text), r.out ? h('pre', { class: 'prev' }, r.out) : null))))),
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => close() }, 'Close')));
  });
}

/* ---------------------------------------------------------------- settings: startup, tray, agents */

const BACKGROUND_SPEC = {
  title: 'Settings',
  submit: 'Save',
  lead: ['Startup, tray and scheduled scans'],
  // Opening the agents dialog closes this one without saving (it has its own Save/Connect steps).
  extra: (close) => [h('h4', {}, 'AI agents'), h('p', { class: 'sub' }, 'Let Claude, Codex, Cursor, Copilot or Gemini use GutCheck\'s scans and fixes over MCP.'),
    h('div', {}, h('button', { onclick: () => { close(null); openAgents(); } }, 'Connect an AI agent…'))],
  fields: [
    { name: 'launchOnStartup', label: 'Launch GutCheck when I log in (starts in the tray)', type: 'checkbox' },
    { name: 'minimizeToTray', label: 'Minimise to the system tray', type: 'checkbox' },
    { name: 'closeToTray', label: 'Closing the window keeps GutCheck running in the tray (quit from the tray menu)', type: 'checkbox' },
    { name: 'scheduleEnabled', label: 'Scan the workspace on a schedule while GutCheck runs, and notify me about new warnings and errors', type: 'checkbox' },
    { name: 'scheduleHours', label: 'Scan every', type: 'select', options: [['1', 'hour'], ['3', '3 hours'], ['6', '6 hours'], ['12', '12 hours'], ['24', 'day'], ['72', '3 days'], ['168', 'week']] },
  ],
};

async function openBackgroundSettings() {
  const cur = await window.api.background();
  const out = await askInputs({ ...BACKGROUND_SPEC, title: state.version ? `Settings · GutCheck ${state.version}` : BACKGROUND_SPEC.title }, cur);
  if (!out) return;
  const saved = await window.api.setBackground(out);
  if (saved.error) return toast(saved.error, 'bad');
  toast(!saved.trayAvailable && (saved.minimizeToTray || saved.closeToTray || saved.launchOnStartup)
    ? 'Saved, but no system tray was found, so the window will stay visible.' : 'Settings saved.');
}
$('background').addEventListener('click', openBackgroundSettings);
