// Content script: adds a "Submit Bulk" button next to "Submit New Workflow" in the Argo Workflows UI
// and runs a list of `--from workflowtemplate/<name> -p k=v` lines one after another.
// Talks to the Argo API same-origin, so the page's own session cookie authenticates it.
(() => {
  if (window.__argoBulkLoaded) return;
  window.__argoBulkLoaded = true;

  const { expandBulk, usedPickerVars, targetsFromTemplates } = globalThis.ArgoBulkParse;
  const BUTTON_TEXT = 'Submit New Workflow';
  const POLL_MS = 5000;
  const MAX_POLL_ERRORS = 5;
  const TERMINAL = { Succeeded: 'succeeded', Failed: 'failed', Error: 'failed' };

  // ---- Argo page helpers -------------------------------------------------------------------

  // Same as the UI's own base handling (ui/src/shared/base.ts): <base href> may be a sub-path.
  function basePath() {
    const href = document.querySelector('base')?.getAttribute('href') || '/';
    const p = new URL(href, location.href).pathname;
    return p.endsWith('/') ? p : `${p}/`;
  }

  function storedNamespace(key) {
    try {
      const v = localStorage.getItem(key);
      return v && v !== 'null' && v !== 'undefined' ? v : '';
    } catch { return ''; }
  }

  // The list page keeps the selected namespace in the URL (workflows/<ns>); a server running with
  // --managed-namespace pins it in localStorage instead.
  function currentNamespace() {
    const managed = storedNamespace('managedNamespace');
    if (managed) return managed;
    const m = /^workflows\/([^/]+)/.exec(location.pathname.slice(basePath().length));
    if (m) return decodeURIComponent(m[1]);
    return storedNamespace('current_namespace') || storedNamespace('userNamespace');
  }

  async function api(method, path, body, signal) {
    const r = await fetch(basePath() + path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) {
      const err = new Error(r.status === 401 ? 'session expired - reload the page and log in again'
        : json?.message || text.slice(0, 200) || r.statusText);
      err.status = r.status;
      throw err;
    }
    return json;
  }

  const submitTemplate = (ns, item, dryRun, signal) => api('POST', `api/v1/workflows/${encodeURIComponent(ns)}/submit`, {
    namespace: ns,
    resourceKind: 'WorkflowTemplate',
    resourceName: item.template,
    submitOptions: { parameters: item.params.map(p => `${p.name}=${p.value}`), dryRun },
  }, signal);

  const getWorkflow = (ns, name, signal) => api('GET',
    `api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}?fields=metadata.name,status.phase,status.message`,
    null, signal);

  // Region/cluster choices come from the enums of a helm-create-* template in the namespace.
  const listHelmCreateTemplates = (ns, signal) => api('GET',
    `api/v1/workflow-templates/${encodeURIComponent(ns)}?namePattern=helm-create-&listOptions.limit=10`, null, signal);

  const workflowUrl = (ns, name) => `${basePath()}workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---- Runner ------------------------------------------------------------------------------

  // Resolves to { state: 'succeeded' | 'failed', message }. Throws AbortError if aborted.
  async function waitForWorkflow(ns, name, signal) {
    let errors = 0;
    for (;;) {
      try {
        const wf = await getWorkflow(ns, name, signal);
        errors = 0;
        const state = TERMINAL[wf?.status?.phase];
        if (state) return { state, message: wf.status.message || wf.status.phase };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.status === 401 || ++errors >= MAX_POLL_ERRORS) {
          return { state: 'failed', message: `lost track of workflow: ${e.message}` };
        }
      }
      await sleep(POLL_MS, signal);
    }
  }

  // Mutates item.state/name/message and calls render() after each change.
  // resume: true skips items already in a terminal state and re-runs skipped ones.
  // onFailureAsk(item): called when onFailure === 'ask' and a workflow fails; must return
  //   a Promise that resolves to 'continue' or 'stop'. May reject with AbortError on abort.
  async function runBatch(items, { ns, dryRun, onFailure, onFailureAsk, signal, render, resume = false }) {
    const set = (item, state, message = '', name = item.name) => {
      Object.assign(item, { state, message, name });
      render();
    };
    if (resume) {
      items.forEach(i => { if (i.state === 'skipped') set(i, 'pending', '', null); });
    } else {
      items.forEach(i => set(i, 'pending', '', null));
    }
    let halted = false;

    for (const item of items) {
      if (resume && item.state !== 'pending') continue;
      if (halted || signal.aborted) { set(item, 'skipped', halted ? 'earlier line failed' : 'stopped'); continue; }
      let result;
      try {
        set(item, 'submitting');
        const wf = await submitTemplate(ns, item, dryRun, signal);
        if (dryRun) {
          result = { state: 'valid', message: 'validated, not submitted' };
        } else {
          set(item, 'running', '', wf.metadata.name);
          result = await waitForWorkflow(ns, wf.metadata.name, signal);
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          set(item, 'stopped', item.name ? 'stopped watching; workflow keeps running'
            : 'stopped mid-submit; check the workflow list to see whether it was created');
          continue;
        }
        result = { state: 'failed', message: e.message };
      }
      set(item, result.state, result.message);
      if (result.state === 'failed' && !dryRun) {
        if (onFailure === 'stop') {
          halted = true;
        } else if (onFailure === 'ask' && onFailureAsk) {
          const decision = await onFailureAsk(item);
          if (decision === 'stop') halted = true;
        }
      }
    }
  }

  // ---- DOM helpers -------------------------------------------------------------------------

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    el.append(...children.flat().filter(c => c != null && c !== false));
    return el;
  }

  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483000; display: flex; align-items: center; justify-content: center; font: 14px/1.4 system-ui, sans-serif; color: #232f3e; }
    .modal { background: #fff; border-radius: 6px; width: min(900px, 94vw); max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    header { padding: 14px 18px; border-bottom: 1px solid #dde3ea; display: flex; justify-content: space-between; align-items: baseline; }
    header h2 { margin: 0; font-size: 17px; }
    .body { padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    textarea { width: 100%; box-sizing: border-box; min-height: 130px; font: 12.5px/1.45 ui-monospace, Menlo, monospace; padding: 8px; border: 1px solid #bcc6d1; border-radius: 4px; resize: vertical; }
    .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .controls .spacer { flex: 1; }
    select { padding: 5px; }
    button { font: inherit; padding: 6px 14px; border-radius: 4px; border: 1px solid #bcc6d1; background: #f4f6f8; cursor: pointer; }
    button.primary { background: #44505f; border-color: #44505f; color: #fff; }
    button.danger { background: #c4413a; border-color: #c4413a; color: #fff; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #edf0f3; vertical-align: top; }
    td.params { font: 12px ui-monospace, Menlo, monospace; word-break: break-all; color: #55606d; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #e6e9ed; }
    .badge.running, .badge.submitting { background: #d7e8fb; color: #174f8c; }
    .badge.succeeded, .badge.valid { background: #d5f0dc; color: #17692f; }
    .badge.failed { background: #f9d9d6; color: #99211b; }
    .badge.stopped { background: #fbebc6; color: #7a5600; }
    .pickers { display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-start; }
    .group-title { font-weight: 600; margin-bottom: 2px; }
    .group-title a { font-weight: 400; margin-left: 8px; font-size: 12px; }
    .opt { display: inline-flex; align-items: center; gap: 4px; margin: 0 14px 2px 0; white-space: nowrap; }
    .err { color: #99211b; }
    .muted { color: #66717e; }
    a { color: #1b6fc2; }
  `;

  const STATE_LABEL = { pending: 'pending', submitting: 'submitting', running: 'running', succeeded: 'succeeded',
    failed: 'failed', valid: 'valid', skipped: 'skipped', stopped: 'stopped' };

  // ---- Modal -------------------------------------------------------------------------------

  let modal = null;

  function openModal() {
    if (modal) return;
    let items = [];
    let abort = null; // AbortController while a batch is running

    // Regions/clusters offered by the picker, and what is ticked. Lists stay in template (enum) order.
    const targets = { loading: true, error: '', source: '', regions: [], clusters: [] };
    const selected = { regions: new Set(), clusters: new Set() };
    const picked = key => targets[key].filter(v => selected[key].has(v));
    const pickers = h('div', { class: 'pickers' });

    const host = h('div', { 'data-argo-bulk-root': true });
    const root = host.attachShadow({ mode: 'open' });
    const nsLabel = h('strong');
    const textarea = h('textarea', {
      spellcheck: 'false',
      placeholder: '--from workflowtemplate/helm-create-kyverno -p region=$region -p clusterName=$cluster -p dryRun=false\n'
        + '--from workflowtemplate/helm-create-kyverno-addons -p region=$region -p clusterName=$cluster -p dryRun=false',
    });
    const onFailure = h('select', {},
      h('option', { value: 'stop' }, 'stop the batch'),
      h('option', { value: 'ask', selected: true }, 'ask what to do'),
      h('option', { value: 'continue' }, 'continue with the next line'));
    const validateBtn = h('button', { onclick: () => start(true) }, 'Validate');
    const runBtn = h('button', { class: 'primary', onclick: () => start(false) }, 'Run');
    const continueBtn = h('button', { class: 'primary', onclick: onContinue }, 'Continue');
    const stopBtn = h('button', { class: 'danger', onclick: onStop }, 'Stop');
    const closeBtn = h('button', { onclick: close }, 'Close');
    const list = h('div');
    const summary = h('div', { class: 'muted' });

    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Submit bulk' },
      h('header', {}, h('h2', {}, 'Submit Bulk'), h('span', { class: 'muted' }, 'namespace: ', nsLabel)),
      h('div', { class: 'body' },
        h('div', { class: 'muted' }, 'One command per line, run in order. Each workflow must finish before the next is submitted. ',
          'Supported: --from workflowtemplate/<name>, -p/--parameter name=value. ',
          '$region and $cluster (or $clusterName) are replaced by the selection below: each line runs once per selected ',
          'region/cluster it uses, finishing one cluster before starting the next.'),
        pickers,
        textarea,
        h('div', { class: 'controls' },
          h('label', {}, 'On failure: ', onFailure),
          h('span', { class: 'spacer' }),
          validateBtn, runBtn, continueBtn, stopBtn, closeBtn),
        summary,
        list));
    root.append(h('style', {}, CSS), h('div', { class: 'backdrop' }, dialog));
    document.body.append(host);
    modal = { host, close };
    textarea.focus();

    const running = () => abort != null;
    let askResolve = null;
    const asking = () => askResolve != null;
    const hasSkipped = () => !running() && items.some(i => i.state === 'skipped');

    function onContinue() {
      if (askResolve) { askResolve('continue'); return; }
      if (hasSkipped()) start(false, true);
    }
    function onStop() {
      if (askResolve) { askResolve('stop'); return; }
      abort?.abort();
    }

    function pickerGroup(label, key) {
      const set = selected[key];
      const link = (text, fn) => h('a', { href: '#', onclick: e => { e.preventDefault(); if (!running()) { fn(); renderPickers(); reparse(); } } }, text);
      return h('div', {},
        h('div', { class: 'group-title' }, label,
          link('all', () => targets[key].forEach(v => set.add(v))), link('none', () => set.clear())),
        targets[key].map(v => h('label', { class: 'opt' },
          h('input', { type: 'checkbox', checked: set.has(v), disabled: running(),
            onchange: e => { if (e.target.checked) set.add(v); else set.delete(v); reparse(); } }),
          v)));
    }

    function renderPickers() {
      pickers.replaceChildren();
      if (targets.loading) { pickers.append(h('span', { class: 'muted' }, 'Loading regions and clusters...')); return; }
      if (targets.error) { pickers.append(h('span', { class: 'muted' }, targets.error)); return; }
      if (targets.regions.length) pickers.append(pickerGroup('Regions', 'regions'));
      pickers.append(pickerGroup('Clusters', 'clusters'),
        h('span', { class: 'muted' }, `(from ${targets.source})`));
    }

    async function loadTargets() {
      const ns = currentNamespace();
      try {
        if (!ns) throw new Error('select a namespace in the Argo UI first');
        const found = targetsFromTemplates((await listHelmCreateTemplates(ns)).items);
        if (!found) throw new Error(`no helm-create-* template with a clusterName list in ${ns}`);
        Object.assign(targets, found);
        if (found.regions.length === 1) selected.regions.add(found.regions[0]);
      } catch (e) {
        targets.error = `Could not load regions/clusters (${e.message}). Type values into the lines instead.`;
      }
      targets.loading = false;
      if (modal?.host !== host) return; // closed while loading
      renderPickers();
      reparse();
    }

    function counts() {
      const c = {};
      items.forEach(i => { c[i.state] = (c[i.state] || 0) + 1; });
      return c;
    }

    function render() {
      const ns = currentNamespace();
      nsLabel.textContent = ns || '(none selected)';
      const bad = items.filter(i => i.errors.length).length;
      const canStart = !running() && !hasSkipped() && items.length > 0 && bad === 0 && !!ns;
      validateBtn.disabled = runBtn.disabled = !canStart;
      validateBtn.hidden = runBtn.hidden = running() || hasSkipped();
      continueBtn.hidden = !asking() && !hasSkipped();
      stopBtn.hidden = !running();
      stopBtn.textContent = asking() ? 'Stop Batch' : 'Stop';
      textarea.disabled = onFailure.disabled = running() || hasSkipped();
      pickers.querySelectorAll('input').forEach(i => { i.disabled = running() || hasSkipped(); });

      list.replaceChildren();
      const showTarget = items.some(i => i.region || i.cluster);
      if (items.length) {
        list.append(h('table', {},
          h('thead', {}, h('tr', {}, ['#', ...(showTarget ? ['Target'] : []), 'Template', 'Parameters', 'Status'].map(t => h('th', {}, t)))),
          h('tbody', {}, items.map(item => h('tr', {},
            h('td', {}, String(item.lineNo)),
            showTarget ? h('td', {}, [item.region, item.cluster].filter(Boolean).join(' / ')) : null,
            h('td', {}, item.template || '-'),
            h('td', { class: 'params' }, item.params.map(p => `${p.name}=${p.value}`).join('  ')),
            h('td', {},
              item.errors.length
                ? h('span', { class: 'err' }, item.errors.join('; '))
                : h('span', { class: `badge ${item.state}` }, STATE_LABEL[item.state] || 'ready'),
              item.name ? h('div', {}, h('a', { href: workflowUrl(ns, item.name), target: '_blank', rel: 'noreferrer' }, item.name)) : null,
              item.message ? h('div', { class: 'muted' }, item.message) : null))))));
      }
      const c = counts();
      const parts = ['succeeded', 'valid', 'failed', 'running', 'skipped', 'stopped'].filter(s => c[s]).map(s => `${c[s]} ${s}`);
      const used = usedPickerVars(textarea.value);
      const missing = ['region', 'cluster'].filter(v => used.has(v) && !picked(v + 's').length);
      summary.textContent = !ns && items.length ? 'Select a namespace in the Argo UI first.'
        : missing.length ? `Tick at least one ${missing.join(' and one ')} above: the lines use ${missing.map(v => '$' + v).join(' and ')}.`
        : bad ? `${bad} line(s) have errors - fix them to continue.`
        : asking() ? `${parts.join(', ')} — continue with the next line or stop the batch?`
        : hasSkipped() ? `${parts.join(', ')} — click Continue to run the remaining items.`
        : parts.join(', ');
    }

    function reparse() {
      if (running() || hasSkipped()) return;
      items = expandBulk(textarea.value, { regions: picked('regions'), clusters: picked('clusters') });
      render();
    }

    async function start(dryRun, resume = false) {
      const ns = currentNamespace();
      if (!ns) return render();
      const count = resume ? items.filter(i => i.state === 'skipped').length : items.length;
      if (!dryRun && !resume && !confirm(`Submit ${count} workflow(s) one after another in namespace "${ns}"?`)) return;
      abort = new AbortController();
      window.addEventListener('beforeunload', warnUnload);
      render();
      try {
        await runBatch(items, {
          ns, dryRun, onFailure: onFailure.value, signal: abort.signal, render, resume,
          onFailureAsk: onFailure.value === 'ask' ? () => new Promise((resolve, reject) => {
            const onAbort = () => { askResolve = null; reject(new DOMException('aborted', 'AbortError')); };
            if (abort.signal.aborted) return onAbort();
            abort.signal.addEventListener('abort', onAbort, { once: true });
            askResolve = val => { abort.signal.removeEventListener('abort', onAbort); askResolve = null; resolve(val); };
            render();
          }) : null,
        });
      } finally {
        abort = null;
        askResolve = null;
        window.removeEventListener('beforeunload', warnUnload);
        render();
      }
    }

    function close() {
      if (running()) {
        if (!confirm('A batch is still running. Stop watching it and close? (Workflows already submitted keep running.)')) return;
        abort.abort(); // also rejects any pending ask promise via its abort listener
      }
      host.remove();
      modal = null;
    }

    textarea.addEventListener('input', reparse); // editing after a run starts a fresh preview
    root.querySelector('.backdrop').addEventListener('mousedown', e => { if (e.target === e.currentTarget) close(); });
    host.addEventListener('keydown', e => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    renderPickers();
    render();
    loadTargets();
  }

  const warnUnload = e => { e.preventDefault(); e.returnValue = ''; };

  // ---- Button injection --------------------------------------------------------------------

  function inject() {
    const orig = [...document.querySelectorAll('button, a')]
      .find(el => !el.closest('[data-argo-bulk-root]') && el.textContent.trim() === BUTTON_TEXT);
    if (!orig) return;
    const existing = document.querySelector('[data-argo-bulk]');
    if (existing && existing.previousElementSibling === orig) return;
    existing?.remove(); // React re-rendered the original; ours is stale

    // Clone so the button picks up exactly the toolbar's styling. React listeners live on the root
    // and are not copied by cloneNode, so the clone is inert until we attach our own.
    const btn = orig.cloneNode(true);
    btn.removeAttribute('id');
    btn.setAttribute('data-argo-bulk', '');
    btn.setAttribute('title', 'Submit several workflow templates in sequence');
    if (btn.tagName === 'A') btn.setAttribute('href', '#');
    else btn.setAttribute('type', 'button');
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes(BUTTON_TEXT)) n.nodeValue = n.nodeValue.replace(BUTTON_TEXT, 'Submit Bulk');
    }
    btn.querySelectorAll('.fa-plus').forEach(i => { i.classList.remove('fa-plus'); i.classList.add('fa-list'); });
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openModal(); });
    orig.after(btn);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; inject(); });
  }).observe(document.body, { childList: true, subtree: true });
  inject();
})();
