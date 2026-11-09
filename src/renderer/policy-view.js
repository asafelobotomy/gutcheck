// The user's own rules: ignoring a finding with a reason, the list of ignored findings, and the
// baseline drift view. Loaded after app.js and modals.js; shares their globals ($, h, put, btn, state,
// askInputs, toast, renderMain, renderList, renderStats).

/* ---------------------------------------------------------------- ignores */

const IGNORE_SPEC = {
  title: 'Ignore this finding',
  submit: 'Ignore',
  fields: [
    { name: 'reason', label: 'Why you accept it (shown wherever the finding would be)', type: 'text', required: true, placeholder: 'e.g. internal tool, no outside contributors' },
    { name: 'allRepos', label: 'Ignore it in every repo', type: 'checkbox' },
  ],
};

async function applyIgnore(r, o) {
  const gen = state.gen;
  const out = await window.api.setIgnore({ dir: r.path, ...o });
  if (!out.ok) return toast(out.error || 'Could not change the ignore list.', 'bad');
  if (gen !== state.gen) return; // a new workspace scan replaced these results meanwhile
  if (out.res) state.repos.set(r.path, out.res);
  if (out.all && Array.isArray(out.repos)) for (const x of out.repos) state.repos.set(x.path, x); // every repo was rescanned
  renderStats(); renderList(); renderMain();
}

function ignoreButton(r, f) {
  return btn('Ignore…', async () => {
    const v = await askInputs({ ...IGNORE_SPEC, title: `Ignore "${f.title}"` }, {});
    if (!v) return;
    await applyIgnore(r, { id: f.id, reason: v.reason, allRepos: !!v.allRepos });
  });
}

// Written through MCP, or by anything other than the CLI or the app (as ignore-rules.js labels it).
const byAgentRule = (f) => f.ignoredIn !== '.gutcheck.json' && f.ignoredVia != null && f.ignoredVia !== 'cli' && f.ignoredVia !== 'app';

function ignoredPanel(r) {
  const list = r.ignored || [];
  if (!list.length) return [];
  return [h('h3', {}, `Ignored (${list.length})`),
    ...list.map((f) => h('div', { class: 'finding ignored' },
      h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, `${f.ignoredBecause}  ·  ${f.ignoredIn === '.gutcheck.json' ? 'from the repo\'s .gutcheck.json' : `${f.ignoredIn === 'all repos' ? 'ignored in every repo' : 'ignored here'}${byAgentRule(f) ? ', ignored through an AI agent (MCP)' : ''}`}`)),
      f.ignoredIn === '.gutcheck.json' ? null : btn('Stop ignoring', () => applyIgnore(r, { id: f.ignoreRule, remove: true, allRepos: f.ignoredIn === 'all repos' }))))];
}

/* ---------------------------------------------------------------- baseline drift */

async function renderDriftView() {
  state.view = 'drift'; state.selected = null;
  renderList();
  const d = await window.api.drift();
  if (state.view !== 'drift') return;
  const head = [h('h2', {}, 'Baseline'), h('p', { class: 'sub' }, 'Your baseline lists what every repo should have. Each repo is compared with it; the ones that differ get a "Baseline" finding.')];
  // Ignore rules GutCheck stores but does not apply (a * with too few characters before it, from an older version).
  const inactive = (d.inactive || []).length ? [h('h3', {}, 'Ignore rules not applied'), ...d.inactive.map((x) => h('div', { class: 'muted' }, `${x.key === '*' ? 'every repo' : x.key}: ${x.id} (${x.why}). Remove it with "gutcheck unignore" and add a longer one.`))] : [];
  head.push(...inactive);
  if (!d.rules) {
    return put($('detail'), ...head, h('p', { class: 'empty' }, 'No baseline yet.'),
      h('div', { class: 'toolbar' }, btn('Create a starting baseline', async () => { const gen = state.gen; const i = await window.api.initBaseline(); if (i && i.ok === false) return toast(i.error || 'Could not create baseline.json.', 'bad'); if (gen === state.gen && i && Array.isArray(i.repos)) { for (const x of i.repos) state.repos.set(x.path, x); renderStats(); renderList(); } toast('Created baseline.json. Edit it to match what you want, then rescan.'); renderDriftView(); })));
  }
  put($('detail'), ...head,
    h('div', { class: 'toolbar' }, btn('Edit baseline.json', () => window.api.openBaseline())),
    h('div', { class: 'muted' }, d.file),
    ...d.rules.map((x) => h('div', { class: 'rec' }, h('span', { class: 'n ' + (x.missing.length ? 'b-warn' : 'b-ok') }, x.missing.length || '✓'),
      h('div', { class: 'grow' }, h('div', {}, `${x.label}  `, x.publicOnly ? h('span', { class: 'pill' }, 'public repos') : null),
        h('div', { class: 'repos' }, x.missing.length ? `Missing in ${x.missing.join(', ')}` : `All ${x.ok} repos it applies to`)))));
}
$('baseline').addEventListener('click', renderDriftView);

/* ---------------------------------------------------------------- scheduled scans */

// A scheduled scan ran in the background: the repo results already streamed in; refresh the rest.
window.api.onDone((out) => {
  if (state.scanning) return;
  $('progress').hidden = true;
  if (out && out.rate) showRate(out.rate);
  loadTrend().then(() => { renderStats(); renderList(); renderMain(); });
  if (out && out.fresh && out.fresh.length) toast(`Scheduled scan: ${out.fresh.length} new finding${out.fresh.length === 1 ? '' : 's'}.`);
});
