// A terminal-style shell for the Argo Workflows UI. Every command submits a WorkflowTemplate - `admin-kubectl`
// for kubectl commands, `admin-aws` for commands starting with `aws` - waits for it, and prints its output
// artifact (stdout) - or, when the workflow fails, the stderr it left in the pod log. Plain script (not a module) because it is injected
// as a content script; the pure parts are also loadable from node for tests.
(function (root) {
  const TOOLS = {
    kubectl: { template: 'admin-kubectl', artifact: 'kubectl-output' },
    aws: { template: 'admin-aws', artifact: 'aws-output' },
  };
  const POLL_MS = 1500;
  const MAX_POLL_ERRORS = 5;
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const DONE = new Set(['Succeeded', 'Failed', 'Error']);
  const enc = encodeURIComponent;

  // When a command doesn't start with 'kubectl', 'k', or 'aws', we replace it with this
  // harmless kubectl command that produces no output.  This trick only works with the deploy
  // role (the readonly role may reject certain characters, though the null command avoids them).
  const NULL_KUBECTL_CMD = 'kubectl get pods --no-headers --selector=nonexistent';

  const history = []; // survives closing the terminal, lost on page reload

  // ---- Pure helpers ------------------------------------------------------------------------

  // The workflow only accepts commands starting with "kubectl", so the prefix is optional when typing,
  // and `k` is an alias for it (`k get pods` is sent as `kubectl get pods`).
  function normaliseCommand(text) {
    const t = (text || '').trim();
    if (!t) return '';
    if (/^k(\s|$)/.test(t)) return `kubectl${t.slice(1)}`;
    return /^kubectl(\s|$)/.test(t) ? t : `kubectl ${t}`;
  }

  // "ns" is a kubens-style meta command, recognised bare or with a leading "kubectl "/"k " - so "ns",
  // "kubectl ns" and "k ns" are all the same command, never sent to kubectl itself (which has no "ns").
  // "ns" alone lists the cluster's namespaces for selection, "ns <name>" (or "ns <number>", picking from
  // that list) sets the default, and "ns -" (also "none"/"default") clears it back to kubectl's own
  // default. Returns null for anything else.
  function parseNsCommand(text) {
    const t = (text || '').trim().replace(/^(kubectl|k)\s+/, '');
    const m = /^ns(?:\s+(\S+))?$/.exec(t);
    if (!m) return null;
    if (!m[1]) return { action: 'show' };
    return /^(-|none|default)$/i.test(m[1]) ? { action: 'clear' } : { action: 'set', value: m[1] };
  }

  // Parses the plain, one-name-per-line output of `kubectl get namespaces -o custom-columns=:metadata.name`.
  function parseNamespaceList(output) {
    return (output || '').split('\n').map(l => l.trim()).filter(Boolean);
  }

  const NS_FLAG = /(^|\s)(-n\b|--namespace\b)/;
  const ALL_NS_FLAG = /(^|\s)(-A\b|--all-namespaces\b)/;

  // True when `command` (a full "kubectl ..." string) already names a namespace or asks for all of them.
  function hasNamespaceFlag(command) {
    return NS_FLAG.test(command) || ALL_NS_FLAG.test(command);
  }

  // Inserts "-n <ns>" right after "kubectl" so every command picks up the default namespace, unless the
  // command already names one (or -A/--all-namespaces) or no default namespace is set.
  function withNamespace(command, ns) {
    if (!ns || hasNamespaceFlag(command) || !/^kubectl(\s|$)/.test(command)) return command;
    return command.replace(/^kubectl/, `kubectl -n ${ns}`);
  }

  // The log endpoint streams one JSON object per line: {"result":{"content":"...","podName":"..."}}.
  function parseLogStream(text) {
    const lines = [];
    for (const raw of (text || '').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') {
          if (typeof j.result?.content === 'string') lines.push(j.result.content);
          continue;
        }
      } catch { /* not JSON: keep the raw line */ }
      lines.push(raw);
    }
    return lines;
  }

  // The pod log is full of script-init noise (the script runs under `set -v`). What the user cares about is
  // whatever follows the workflow's own "COMMAND: ..." line, or the validation message if it never got there.
  function stderrFromLog(lines) {
    let from = -1;
    lines.forEach((l, i) => { if (/^COMMAND: /.test(l)) from = i; });
    let rest;
    if (from >= 0) rest = lines.slice(from + 1).filter(l => !/^eval "\$COMMAND/.test(l));
    else rest = lines.filter(l => /^Command is /.test(l));
    if (!rest.length && from < 0) rest = lines.slice(-3);
    return rest.join('\n').trim();
  }

  function artifactNodeId(wf, artifact = TOOLS.kubectl.artifact) {
    const nodes = Object.values(wf?.status?.nodes || {});
    return nodes.find(n => (n.outputs?.artifacts || []).some(a => a.name === artifact))?.id || null;
  }

  // Which workflow a line goes to: `aws ...` runs admin-aws, everything else is kubectl (see normaliseCommand).
  function parseInput(text) {
    const t = (text || '').trim();
    return /^aws(\s|$)/.test(t) ? { tool: 'aws', command: t } : { tool: 'kubectl', command: normaliseCommand(t) };
  }

  // ---- Running a command -------------------------------------------------------------------

  async function getText(basePath, path, signal) {
    const r = await fetch(basePath() + path, { credentials: 'same-origin', signal });
    if (!r.ok) {
      const err = new Error(r.status === 401 ? 'session expired - reload the page and log in again'
        : (await r.text()).slice(0, 200) || r.statusText);
      err.status = r.status;
      throw err;
    }
    return r.text();
  }

  async function waitForPhase(ctx, ns, name, signal, onPhase) {
    let errors = 0;
    for (;;) {
      try {
        const wf = await ctx.api('GET', `api/v1/workflows/${enc(ns)}/${enc(name)}?fields=status.phase,status.message`, null, signal);
        errors = 0;
        const phase = wf?.status?.phase || '';
        if (DONE.has(phase)) return { phase, message: wf.status.message || '' };
        onPhase(phase ? phase.toLowerCase() : 'queued');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.status === 401 || ++errors >= MAX_POLL_ERRORS) throw new Error(`lost track of workflow ${name}: ${e.message}`);
      }
      await ctx.sleep(POLL_MS, signal);
    }
  }

  // ctx: { api, getText, sleep }. Resolves to { ok, name, output, errors, message }.
  // Throws on submit/poll failures; AbortError if aborted (onSubmitted tells the caller which workflow keeps running).
  async function runCommand(ctx, { ns, tool = 'kubectl', params, signal, onPhase = () => {}, onSubmitted = () => {} }) {
    const { template, artifact } = TOOLS[tool];
    onPhase('submitting');
    const submitted = await ctx.api('POST', `api/v1/workflows/${enc(ns)}/submit`, {
      namespace: ns,
      resourceKind: 'WorkflowTemplate',
      resourceName: template,
      submitOptions: { parameters: Object.entries(params).map(([k, v]) => `${k}=${v}`) },
    }, signal);
    const name = submitted.metadata.name;
    onSubmitted(name);

    const { phase, message } = await waitForPhase(ctx, ns, name, signal, onPhase);
    const ok = phase === 'Succeeded';

    let output = '';
    try {
      const wf = await ctx.api('GET', `api/v1/workflows/${enc(ns)}/${enc(name)}?fields=status.nodes`, null, signal);
      // The template's main step is the pod itself, so its node id is the workflow name.
      const nodeId = artifactNodeId(wf, artifact) || name;
      output = await ctx.getText(`artifact-files/${enc(ns)}/workflows/${enc(name)}/${enc(nodeId)}/outputs/${artifact}`, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e; // no artifact (e.g. failed before the command ran)
    }

    let errors = '';
    if (!ok || !output.trim()) {
      try {
        errors = stderrFromLog(parseLogStream(await ctx.getText(`api/v1/workflows/${enc(ns)}/${enc(name)}/log?logOptions.container=main`, signal)));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return { ok, name, output, errors, message };
  }

  // ---- Terminal UI -------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; top: 0; right: 0; bottom: 0; left: var(--left, 0px); background: rgba(0,0,0,.55); z-index: 2147483000; display: flex; align-items: center; justify-content: center; font: 13px/1.45 ui-monospace, Menlo, Consolas, monospace; }
    .term { background: #0d1117; color: #c9d1d9; border-radius: 6px; width: calc(100% - 32px); height: calc(100% - 32px); display: flex; flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.5); overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font: 12px system-ui, sans-serif; color: #8b949e; }
    .bar strong { color: #c9d1d9; }
    .bar .spacer { flex: 1; }
    .bar select, .bar button { font: inherit; color: #c9d1d9; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 2px 6px; }
    .bar button { cursor: pointer; }
    .screen { flex: 1; overflow: auto; padding: 10px 14px; cursor: text; }
    .screen > div { white-space: pre; min-height: 1.45em; }
    .prompt { color: #3fb950; margin-right: 8px; user-select: none; }
    .prompt.deploy { color: #f85149; }
    .out { color: #c9d1d9; }
    .err { color: #ff7b72; }
    .muted { color: #8b949e; }
    .muted a { color: #58a6ff; }
    .inputwrap { border-top: 1px solid #21262d; }
    .inputrow { display: flex; align-items: center; padding: 8px 14px; }
    .inputrow .prompt { white-space: pre; }
    .queue:not(:empty) { padding: 4px 14px; border-bottom: 1px dashed #30363d; }
    .queue-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; color: #d29922; }
    .queue-row span { color: #8b949e; width: 1.4em; flex: none; text-align: right; }
    .queue-row input { color: #d29922; }
    .queue-row button { padding: 0 5px; line-height: 1.6; font-size: 11px; }
    input { flex: 1; background: transparent; border: 0; outline: 0; color: #c9d1d9; font: inherit; caret-color: #c9d1d9; padding: 0; }
  `;

  const HELP = [
    'Type a kubectl command; the leading "kubectl" is optional and "k" is an alias for it. It runs the admin-kubectl',
    'workflow on the selected region/cluster.',
    'Commands starting with "aws" run the admin-aws workflow instead (the account of the namespace; region/cluster do not apply).',
    'readonly role: the characters < > ; & | are rejected.   deploy role: no character restrictions.   ssg-deploy: aws only.',
    'Non-kubectl/non-aws commands are silently replaced with a no-op kubectl command.',
    'This no-op trick requires the deploy role; without it a warning is shown.',
    'ns             list the cluster\'s namespaces (runs "kubectl get namespaces"), numbered for picking from.',
    'ns <name>      set the default namespace added to kubectl commands: "get pods" then runs as',
    '               "kubectl -n <name> get pods". "ns <number>" picks by number from the last "ns" listing.',
    'ns -           clear it (also "ns none" / "ns default").',
    '               a command that already has -n/--namespace or -A/--all-namespaces is left alone.',
    '               "ns" also works as "kubectl ns" / "k ns" - it is never sent to kubectl itself.',
    'Typing and pressing Enter while a command is running queues the next one; it starts once the current',
    'one (and anything queued before it) finishes - nothing is submitted early. Ctrl+C also drops the queue.',
    'Queued (not yet running) commands can be edited in place, reordered, bumped to the front, or removed',
    'before their turn comes, using the controls shown next to each one.',
    'clear (Ctrl+L)   exit (Esc)   Ctrl+C stop waiting   Up/Down history',
  ].join('\n');

  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
  const recall = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

  // Right edge (px) of the Argo sidebar, so the shell can sit beside it instead of over it. The sidebar is
  // found by shape rather than class name: a tall, narrow element pinned to the left edge of the window.
  function sidebarWidth() {
    let best = 0;
    for (const el of document.querySelectorAll('nav, aside, [class*="nav"], [class*="sidebar"]')) {
      if (el.closest('[data-argo-bulk-root]')) continue;
      const r = el.getBoundingClientRect();
      if (r.left <= 1 && r.width >= 20 && r.width <= innerWidth * 0.4 && r.height >= innerHeight * 0.6) {
        best = Math.max(best, Math.round(r.right));
      }
    }
    return best;
  }

  // deps: { api, basePath, currentNamespace, h, sleep, targetsFromTemplates, onClose }. Returns { host, close }.
  function openShell(deps) {
    const { api, basePath, currentNamespace, h, sleep, targetsFromTemplates, onClose } = deps;
    const ns = currentNamespace();
    const ctx = { api, sleep, getText: (path, signal) => getText(basePath, path, signal) };

    const host = h('div', { 'data-argo-bulk-root': true });
    const root = host.attachShadow({ mode: 'open' });
    const regionSel = h('select', { title: 'region' });
    const clusterSel = h('select', { title: 'cluster' });
    const roleSel = h('select', { title: 'role: deploy lifts the character restrictions and needs the admins group' });
    const closeBtn = h('button', { onclick: () => close(), title: 'Close (Esc)' }, 'Close');
    const screen = h('div', { class: 'screen' });
    const promptEl = h('span', { class: 'prompt' });
    const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'command' });
    const queueEl = h('div', { class: 'queue' });
    const nsBadge = h('span', { class: 'muted', title: 'default k8s namespace added to kubectl commands - set with "ns <name>", cleared with "ns -"' });

    root.append(h('style', {}, CSS), h('div', { class: 'backdrop' },
      h('div', { class: 'term', role: 'dialog', 'aria-label': 'shell' },
        h('div', { class: 'bar' }, h('strong', {}, 'shell'), h('span', {}, ns || ''), nsBadge,
          h('span', { class: 'spacer' }), regionSel, clusterSel, roleSel, closeBtn),
        screen,
        h('div', { class: 'inputwrap' }, queueEl, h('div', { class: 'inputrow' }, promptEl, input)))));
    document.body.append(host);
    const fit = () => host.style.setProperty('--left', `${sidebarWidth()}px`);
    fit();
    window.addEventListener('resize', fit);

    let abort = null; // AbortController while a command is running
    let ready = false;
    let histPos = history.length;
    const queue = []; // commands typed while one is running; run in order once it finishes, nothing submitted early

    const scroll = () => { screen.scrollTop = screen.scrollHeight; };
    const print = (cls, text) => { const el = h('div', { class: cls }, text); screen.append(el); scroll(); return el; };
    const privileged = () => roleSel.value !== 'readonly'; // deploy / ssg-deploy
    const promptText = () => `${[regionSel.value, clusterSel.value].filter(Boolean).join('/') || 'shell'} ${privileged() ? '#' : '$'}`;
    const roleClass = () => (privileged() ? 'deploy' : 'readonly');
    const templates = {}; // tool -> WorkflowTemplate, for the tools available in this namespace
    let k8sNs = recall('argo-shell:k8sNs'); // default -n applied to kubectl commands (not the Argo namespace)

    function refreshNsBadge() {
      nsBadge.textContent = k8sNs ? `ns: ${k8sNs}` : '';
    }

    function refreshPrompt() {
      promptEl.textContent = promptText();
      promptEl.className = `prompt ${roleClass()}`;
    }

    // Typing (and queueing with Enter) is allowed while a command runs; only the pickers are locked,
    // since a queued command reads them when it actually starts, not when it was typed.
    function setBusy(busy) {
      input.readOnly = !ready;
      regionSel.disabled = clusterSel.disabled = roleSel.disabled = busy;
    }

    const echoLine = text => screen.append(h('div', {}, h('span', { class: `prompt ${roleClass()}` }, promptText()), text));
    let lastNamespaces = []; // from the most recent "ns" listing, so "ns 2" can pick by number

    // Local commands never touch the workflow, so they can run synchronously; everything else goes
    // through runWorkflowCommand (ns is handled separately in runQueue - see parseNsCommand). Returns
    // true if `text` was handled locally.
    function runLocal(text) {
      const word = text.split(/\s+/)[0];
      if (word === 'clear') { screen.replaceChildren(); return true; }
      if (!['exit', 'help'].includes(word)) return false;
      echoLine(text);
      if (word === 'exit') close();
      else print('muted', HELP);
      return true;
    }

    // "ns <name-or-number>" / "ns -": sets or clears the default namespace. No network call, so this
    // runs synchronously - the caller is responsible for echoing `text` first.
    function applyNsSet(nsCmd) {
      if (nsCmd.action === 'clear') {
        k8sNs = '';
        remember('argo-shell:k8sNs', k8sNs);
        refreshNsBadge();
        print('muted', 'ns cleared');
        return;
      }
      let resolved = nsCmd.value;
      if (/^\d+$/.test(resolved)) {
        const idx = Number(resolved) - 1;
        if (!(idx >= 0 && idx < lastNamespaces.length)) {
          print('err', `no namespace #${resolved} - run "ns" to list namespaces first`);
          return;
        }
        resolved = lastNamespaces[idx];
      }
      k8sNs = resolved;
      remember('argo-shell:k8sNs', k8sNs);
      refreshNsBadge();
      print('muted', `ns set to ${k8sNs}`);
    }

    // "ns" alone: lists the cluster's namespaces (a real kubectl command, so it needs the workflow) for
    // the user to pick from with "ns <number>" or "ns <name>". Marks the current default, if any.
    async function runNamespaceList(text) {
      await runWorkflowCommand(text, {
        commandOverride: 'kubectl get namespaces -o custom-columns=:metadata.name --no-headers',
        render: r => {
          if (!r.ok) {
            print('err', r.errors || r.message || 'could not list namespaces');
            print('muted', h('a', { href: `${basePath()}workflows/${enc(ns)}/${enc(r.name)}`, target: '_blank', rel: 'noreferrer' }, r.name));
            return;
          }
          lastNamespaces = parseNamespaceList(r.output);
          if (!lastNamespaces.length) { print('muted', 'no namespaces returned'); return; }
          lastNamespaces.forEach((n, i) => print(n === k8sNs ? 'out' : 'muted', `${i + 1}. ${n}${n === k8sNs ? '  (current)' : ''}`));
          print('muted', 'pick one: "ns <number>" or "ns <name>"');
        },
      });
    }

    function fillSelect(sel, values, saved) {
      sel.replaceChildren(...values.map(v => h('option', { value: v }, v)));
      sel.value = values.includes(saved) ? saved : values[0] ?? '';
      sel.hidden = !values.length;
    }

    const roleEnum = tpl => {
      const e = (tpl?.spec?.arguments?.parameters || []).find(p => p.name === 'role')?.enum;
      return e?.length ? e.map(String) : ['readonly', 'deploy'];
    };

    async function loadTargets() {
      try {
        if (!ns) throw new Error('select a namespace in the Argo UI first');
        const problems = [];
        await Promise.all(Object.entries(TOOLS).map(async ([tool, { template }]) => {
          try { templates[tool] = await api('GET', `api/v1/workflow-templates/${enc(ns)}/${template}`); }
          catch (e) { problems.push(`${template} is not available: ${e.message}`); }
        }));
        if (!Object.keys(templates).length) throw new Error(problems.join('; '));
        if (!host.isConnected) return; // closed while loading

        const roles = [...new Set(Object.keys(TOOLS).filter(t => templates[t]).flatMap(t => roleEnum(templates[t])))];
        fillSelect(roleSel, roles, 'readonly');
        const found = templates.kubectl && targetsFromTemplates([templates.kubectl]);
        fillSelect(regionSel, found?.regions || [], recall('argo-shell:region'));
        fillSelect(clusterSel, found?.clusters || [], recall('argo-shell:cluster'));
        ready = true;
        print('muted', `${ns} - type "help" for usage`);
        problems.forEach(p => print('err', p));
      } catch (e) {
        if (!host.isConnected) return;
        regionSel.hidden = clusterSel.hidden = true;
        print('err', `cannot use the shell in ${ns || 'this namespace'}: ${e.message}`);
      }
      setBusy(false);
      refreshPrompt();
      input.focus();
    }

    // Runs one command against a workflow. Assumes `text` is not a local command (see runLocal) and not
    // a bare "ns" (see runNamespaceList, which calls back into this with commandOverride).
    // opts.commandOverride, if given, is what's actually sent instead of parsing `text` (still echoed
    // and still subject to role/template checks); opts.render, if given, replaces the default
    // output/error printing so the caller can interpret the result itself.
    async function runWorkflowCommand(text, opts = {}) {
      echoLine(text);
      let parsed = parseInput(text);
      let tool = parsed.tool, command = opts.commandOverride ?? parsed.command;
      if (!opts.commandOverride) {
        // Detect whether the original input is a recognised kubectl/k/aws command.
        // Everything else is treated as an arbitrary command and replaced with a no-op.
        const isKubectlCmd = /^kubectl(\s|$)/.test(text) || /^k(\s|$)/.test(text);
        const isAwsCmd = /^aws(\s|$)/.test(text);
        if (tool === 'kubectl' && !isKubectlCmd && !isAwsCmd) {
          if (!privileged()) {
            print('err', 'Non-kubectl commands require the deploy role. ' +
              'The command has been replaced with a no-op kubectl command.');
          }
          command = NULL_KUBECTL_CMD;
        } else if (tool === 'kubectl') {
          command = withNamespace(command, k8sNs);
        }
      }
      if (!templates[tool]) { print('err', `${TOOLS[tool].template} is not available in ${ns}`); return; }
      const roles = roleEnum(templates[tool]);
      if (!roles.includes(roleSel.value)) {
        print('err', `role "${roleSel.value}" is not valid for ${tool} (${roles.join(', ')}) - pick another role above`);
        return;
      }
      // admin-aws has no cluster/region arguments (its region comes from the chart values).
      const params = tool === 'aws'
        ? { role: roleSel.value, command, dryRun: 'false' }
        : { clusterName: clusterSel.value, role: roleSel.value, command, dryRun: 'false' };
      if (tool === 'kubectl' && regionSel.value) params.region = regionSel.value;

      let phase = 'submitting';
      let workflow = '';
      const status = print('muted', '');
      let frame = 0;
      const spin = setInterval(() => { status.textContent = `${SPINNER[frame++ % SPINNER.length]} ${phase}...`; }, 100);
      abort = new AbortController();
      setBusy(true);
      try {
        const r = await runCommand(ctx, {
          ns, tool, params, signal: abort.signal, onPhase: p => { phase = p; }, onSubmitted: n => { workflow = n; },
        });
        status.remove();
        if (opts.render) {
          opts.render(r);
        } else {
          if (r.output.trim()) print('out', r.output.replace(/\n+$/, ''));
          if (r.errors) print('err', r.errors);
          if (!r.ok) {
            if (!r.errors) print('err', r.message || 'command failed');
            print('muted', h('a', { href: `${basePath()}workflows/${enc(ns)}/${enc(r.name)}`, target: '_blank', rel: 'noreferrer' }, r.name));
          }
        }
      } catch (e) {
        status.remove();
        if (e.name === 'AbortError') print('muted', `^C${workflow ? ` (workflow ${workflow} keeps running)` : ''}`);
        else print('err', e.message);
      } finally {
        clearInterval(spin);
        abort = null;
      }
    }

    // Drains the queue strictly in order - a command only starts once everything typed before it has
    // finished. clear/exit/help resolve immediately since they never touch the network; "ns <name>"/"ns -"
    // likewise (no network call); a bare "ns" does need one (it lists the cluster's namespaces).
    // Only one instance of this loop ever runs at a time.
    async function runQueue() {
      while (queue.length) {
        const text = queue.shift().trim();
        renderQueue();
        if (!text) continue; // edited down to nothing - drop it silently rather than running a no-op
        const nsCmd = parseNsCommand(text);
        if (nsCmd && nsCmd.action !== 'show') { echoLine(text); applyNsSet(nsCmd); }
        else if (nsCmd) await runNamespaceList(text);
        else if (!runLocal(text)) await runWorkflowCommand(text);
        if (!host.isConnected) return; // closed mid-queue
      }
      setBusy(false);
      input.focus();
      scroll();
    }

    // Queued commands (anything not yet started - see runQueue) are shown one per row, each with its own
    // editable text box plus buttons to reorder, delete, or run it right now, skipping ahead of the rest.
    function renderQueue() {
      queueEl.replaceChildren(...queue.map((text, i) => h('div', { class: 'queue-row' },
        h('span', {}, `${i + 1}.`),
        h('input', {
          type: 'text', value: text, spellcheck: 'false', autocomplete: 'off',
          oninput: e => { queue[i] = e.target.value; },
          onkeydown: e => {
            if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); input.focus(); }
            e.stopPropagation(); // don't let Up/Down/Enter reach the command input behind it
          },
        }),
        h('button', { title: 'move up', disabled: i === 0, onclick: () => reorderQueue(i, i - 1) }, '↑'),
        h('button', { title: 'move down', disabled: i === queue.length - 1, onclick: () => reorderQueue(i, i + 1) }, '↓'),
        h('button', {
          title: abort ? 'move to the front of the queue (it still waits for the command currently running)' : 'move to the front of the queue',
          disabled: i === 0, onclick: () => reorderQueue(i, 0),
        }, '⏪'),
        h('button', { title: 'remove', onclick: () => removeQueueItem(i) }, '✕'))));
    }

    function reorderQueue(from, to) {
      queue.splice(to, 0, queue.splice(from, 1)[0]);
      renderQueue();
    }

    function removeQueueItem(i) {
      queue.splice(i, 1);
      renderQueue();
      if (!queue.length && !abort) { setBusy(false); input.focus(); } // nothing left and nothing running
    }

    function close() {
      abort?.abort();
      queue.length = 0;
      window.removeEventListener('resize', fit);
      host.remove();
      onClose?.();
    }

    const selectedText = () => (root.getSelection ? root.getSelection() : getSelection()).toString();

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || !ready) return;
        input.value = '';
        if (history[history.length - 1] !== text) history.push(text);
        histPos = history.length;
        const wasRunning = abort != null || queue.length > 0;
        queue.push(text);
        renderQueue();
        if (!wasRunning) { setBusy(true); runQueue(); }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        histPos = Math.max(0, Math.min(history.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
        input.value = history[histPos] ?? '';
      }
    });
    host.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      else if (e.ctrlKey && e.key === 'l') { e.preventDefault(); screen.replaceChildren(); }
      else if (e.ctrlKey && e.key === 'c' && abort && !selectedText()) {
        e.preventDefault();
        if (queue.length) { print('muted', `(dropped ${queue.length} queued command(s))`); queue.length = 0; renderQueue(); }
        abort.abort();
      }
      e.stopPropagation(); // keep Argo's own keyboard shortcuts out of it
    });
    screen.addEventListener('click', () => { if (!selectedText()) input.focus(); });
    // Clicking outside the terminal is easy to do by accident, so ask first (Esc and Close still close directly).
    root.querySelector('.backdrop').addEventListener('mousedown', e => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault(); // keep focus in the input while the dialog is open
      if (confirm(abort ? 'A command is still running. Close the shell? (The workflow keeps running.)' : 'Close the shell?')) close();
      else input.focus();
    });
    regionSel.addEventListener('change', () => { remember('argo-shell:region', regionSel.value); refreshPrompt(); input.focus(); });
    clusterSel.addEventListener('change', () => { remember('argo-shell:cluster', clusterSel.value); refreshPrompt(); input.focus(); });
    roleSel.addEventListener('change', () => { refreshPrompt(); input.focus(); });

    setBusy(true);
    refreshPrompt();
    refreshNsBadge();
    input.focus();
    loadTargets();
    return { host, close };
  }

  const api = {
    openShell, runCommand, normaliseCommand, parseInput, parseLogStream, stderrFromLog, artifactNodeId,
    parseNsCommand, parseNamespaceList, hasNamespaceFlag, withNamespace,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArgoShell = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
