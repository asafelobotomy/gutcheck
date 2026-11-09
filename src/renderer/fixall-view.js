// "Fix all issues" for one repo: a short wizard for the fixes only the owner can choose, then one
// review of every change in run order (each can be unticked). Loaded after app.js and modals.js;
// shares their globals ($, h, modal, runActions, FixAll).

// decisions -> Promise of answers [{ action, sev }] (null action = leave it), or null if cancelled.
function decisionWizard(r, decisions) {
  const picks = decisions.map((d) => d.pick);
  const values = decisions.map(() => ({}));
  return modal((box, close) => {
    let i = 0;
    const render = () => {
      const d = decisions[i];
      const choice = () => d.choices[picks[i]];
      const fieldsEl = h('div', { class: 'wfields' });
      const drawFields = () => {
        fieldsEl.replaceChildren(...((choice().fields) || []).map((f) => {
          const input = h('input', { type: 'text', spellcheck: 'false', placeholder: f.placeholder || '' });
          input.value = values[i][f.name] || '';
          input.addEventListener('input', () => { values[i][f.name] = input.value; check(); });
          return h('label', { class: 'frow' }, h('span', {}, f.label), input);
        }));
      };
      const next = h('button', { class: 'primary' }, i === decisions.length - 1 ? 'Add to the plan' : 'Next');
      const check = () => { next.disabled = ((choice().fields) || []).some((f) => f.required && !String(values[i][f.name] || '').trim()); };
      const options = d.choices.map((c, k) => {
        const radio = h('input', { type: 'radio', name: 'wchoice' });
        radio.checked = picks[i] === k;
        radio.addEventListener('change', () => { picks[i] = k; drawFields(); check(); });
        return h('label', { class: 'frow chk' }, radio, ' ', c.label);
      });
      next.addEventListener('click', () => {
        if (i < decisions.length - 1) { i++; render(); return; }
        close(decisions.map((dd, k) => {
          const c = dd.choices[picks[k]];
          if (!c.action) return null;
          const extra = Object.fromEntries(Object.entries(values[k]).map(([key, v]) => [key, String(v).trim()]));
          return { action: { ...c.action, ...extra }, sev: (r.findings.find((f) => f.id === dd.id) || {}).severity };
        }));
      });
      const back = h('button', {}, 'Back');
      back.disabled = i === 0;
      back.addEventListener('click', () => { i--; render(); });
      drawFields();
      check();
      box.replaceChildren(
        h('h3', { class: 'mh', id: 'modal-title' }, `Your call ${i + 1} of ${decisions.length}: ${r.name}`),
        h('p', { class: 'sub' }, 'GutCheck can fix these too, but only you can choose how. Nothing runs yet: your answers join the plan, and you review it all before anything happens.'),
        h('div', { class: 'wcard' }, h('b', {}, d.title), d.detail ? h('div', { class: 'muted' }, d.detail) : null, ...options, fieldsEl),
        h('div', { class: 'mbtns' }, h('button', { onclick: () => close(null) }, 'Cancel'), back, next));
      (box.querySelector('.wfields input') || box.querySelector('input[type=radio]:checked') || next).focus();
    };
    box.classList.add('wide');
    render();
  });
}

// all: FixAll.plan(r). Ask the decisions (if any), then review and apply everything in run order.
async function fixAllIssues(r, all) {
  const answers = all.decisions.length ? await decisionWizard(r, all.decisions) : [];
  if (answers == null) return;
  const { actions, note } = FixAll.order(r, all.actions, answers);
  if (!actions.length) return toast('Nothing to do: every remaining issue was left for later.');
  const left = all.decisions.filter((_, k) => !answers[k]);
  const lead = [];
  if (note) lead.push(note);
  if (left.length) lead.push(`Left for later: ${left.map((d) => d.title).join('; ')}.`);
  if (all.skipped.length) lead.push(`Not part of this repo: ${all.skipped.map((s) => `${s.title} (${s.reason})`).join('; ')}.`);
  return runActions(actions.map((action) => ({ repo: r, action })), { ask: false, lead, hold: FixAll.automatic });
}
