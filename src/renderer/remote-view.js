// Repos on GitHub that are not cloned in the workspace (source "remote"): their chip in the list,
// the All / Local / Remote filter, how the detail view describes them, the scan progress label for
// the remote stage, and Settings > GitHub repos not cloned here. Findings only: Fix all and the fix
// buttons are off for them (fix-all.js says why).

const RemoteView = (() => {
  const isRemote = (r) => !!r && r.source === 'remote';
  const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round((n || 0) / 1024 ** 2)} MB`);
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

  // The repos the list shows; hides the filter while no repo is remote.
  function visible(rs) {
    const sel = $('source');
    const any = rs.some(isRemote);
    sel.hidden = !any;
    const v = any ? sel.value : 'all';
    return v === 'all' ? rs : rs.filter((r) => (v === 'remote') === isRemote(r));
  }

  const chip = (r) => (isRemote(r) ? h('span', { class: 'pill remote' }, r.partial ? 'Remote · GitHub checks only' : 'Remote') : null);
  const where = (r) => (isRemote(r) ? `Not cloned in this workspace${r.partial ? '  ·  GitHub checks only' : ''}` : r.path);
  const note = (r) => (isRemote(r) ? h('p', { class: 'remote-note' }, FixAll.REMOTE_BLOCKED) : null);
  const progress = (res, done, total, stage) => (stage === 'remote' ? `Checking remote repos: ${done}/${total} (${res.name})` : `Scanned ${done}/${total}`);

  async function openSettings() {
    const info = await window.api.remote();
    let orgs = [];
    try { orgs = await window.api.remoteOrgs(); } catch {}
    const s = info.settings;
    const out = await askInputs({
      title: 'GitHub repos not cloned here',
      submit: 'Save',
      lead: ['GutCheck keeps a shallow copy of each one in its own data folder to check its files. Nothing in them runs, and they are never changed.',
        orgs.length ? `Your organisations: ${orgs.join(', ')}` : 'You are not in any GitHub organisation (or gh could not list them).'],
      fields: [
        { name: 'enabled', label: 'Check my GitHub repos that are not cloned in this folder', type: 'checkbox' },
        { name: 'orgs', label: 'Organisations to include (comma-separated)', placeholder: 'acme, my-org' },
        { name: 'forks', label: 'Include forks', type: 'checkbox' },
        { name: 'archived', label: 'Include archived repos', type: 'checkbox' },
        { name: 'skip', label: 'Leave out (owner/name, comma-separated)', placeholder: 'me/old-thing' },
        { name: 'maxSizeMB', label: 'Largest repo to download (MB)' },
        { name: 'cacheMaxGB', label: 'Space for downloaded copies (GB)' },
        { name: 'clear', label: `Delete the downloaded copies now (${size(info.cacheBytes)})`, type: 'checkbox' },
      ],
    }, { ...s, orgs: s.orgs.join(', '), skip: s.skip.join(', '), maxSizeMB: String(s.maxSizeMB), cacheMaxGB: String(s.cacheMaxGB), clear: false });
    if (!out) return;
    await window.api.setRemote({ enabled: out.enabled, orgs: list(out.orgs), forks: out.forks, archived: out.archived, skip: list(out.skip), maxSizeMB: Number(out.maxSizeMB), cacheMaxGB: Number(out.cacheMaxGB) });
    if (out.clear) await window.api.remoteClear();
    toast(out.enabled ? 'Saved. Remote repos are checked on the next scan.' : 'Saved.');
  }

  $('source').addEventListener('change', () => renderList());
  return { isRemote, visible, chip, where, note, progress, openSettings };
})();
