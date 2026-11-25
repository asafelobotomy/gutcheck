// The footer bar shown while reviewed changes are applied: which change of how many, the command
// running now, and the rescan after each one, so a long Fix all is never a silent wait before the
// results dialog. main.js forwards service.applyActions' onProgress as action:progress.
// Loaded after app.js and shares its globals ($).
const ApplyProgress = (() => {
  let active = false;
  let failed = 0;
  const bar = () => $('applybar');

  function set(pct, text) {
    $('abar').style.width = pct + '%';
    bar().setAttribute('aria-valuenow', String(pct));
    $('atext').textContent = text;
    bar().title = text; // the full line when the footer cuts it short
  }

  function show(total) {
    active = true;
    failed = 0;
    bar().hidden = false;
    bar().classList.add('run');
    document.body.classList.add('applying');
    set(0, `Applying ${total} change${total === 1 ? '' : 's'}…`);
  }

  function hide() {
    active = false;
    bar().hidden = true;
    bar().classList.remove('run');
    document.body.classList.remove('applying');
  }

  // p: { index, total, repoName, title, phase: start | step | rescan | done, step, steps, text, ok }
  function update(p) {
    if (!active || !p || !(p.total > 0)) return;
    if (p.phase === 'done' && !p.ok) failed++;
    // Within one change: its commands share most of the slice, the rescan after them the rest.
    const part = p.phase === 'step' && p.steps > 0 ? (p.step / p.steps) * 0.9 : p.phase === 'rescan' ? 0.9 : p.phase === 'done' ? 1 : 0;
    const pct = Math.max(0, Math.min(100, Math.round(((p.index + part) / p.total) * 100)));
    const what = p.phase === 'step' ? (p.steps > 1 ? `step ${p.step + 1} of ${p.steps}: ` : '') + (p.text || '')
      : p.phase === 'rescan' ? 'rescanning to show the result…'
      : p.phase === 'done' ? (p.ok ? 'done' : 'failed') : 'starting…';
    const head = `Change ${p.index + 1} of ${p.total}${p.repoName ? ` · ${p.repoName}` : ''}${p.title ? `: ${p.title}` : ''}`;
    set(pct, `${head} — ${what}${failed ? ` (${failed} failed so far)` : ''}`);
  }

  if (window.api && window.api.onApplyProgress) window.api.onApplyProgress(update);
  return { show, hide, update };
})();
