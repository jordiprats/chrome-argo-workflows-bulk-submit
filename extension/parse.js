// Parses `argo submit`-style lines into submit requests. Plain script (not a module) because it is
// injected as a content script; also loadable from node for tests.
(function (root) {
  const TEMPLATE_KINDS = /^(workflowtemplates?|wftmpls?)$/i;
  const IGNORED_FLAGS = new Set(['-w', '--wait', '--watch']);
  const UNRESOLVED = /\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)/;

  // Shell-ish split: whitespace separated, '…' literal, "…" with \ escapes, \ escapes outside quotes.
  // `shellVar` is true when a $var shows up outside single quotes (i.e. a shell would have expanded it).
  function tokenize(line) {
    const tokens = [];
    let cur = '';
    let inToken = false;
    let shellVar = false;
    let quote = null;
    const push = () => {
      if (inToken) tokens.push({ text: cur, shellVar });
      cur = ''; inToken = false; shellVar = false;
    };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null; else cur += c;
      } else if (quote === '"') {
        if (c === '"') quote = null;
        else if (c === '\\' && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) cur += line[++i];
        else { if (c === '$' && UNRESOLVED.test(line.slice(i))) shellVar = true; cur += c; }
      } else if (c === "'" || c === '"') {
        quote = c; inToken = true;
      } else if (c === '\\' && i + 1 < line.length) {
        cur += line[++i]; inToken = true;
      } else if (/\s/.test(c)) {
        push();
      } else {
        if (c === '$' && UNRESOLVED.test(line.slice(i))) shellVar = true;
        cur += c; inToken = true;
      }
    }
    if (quote) throw new Error(`unterminated ${quote} quote`);
    push();
    return tokens;
  }

  function parseParam(text) {
    const eq = text.indexOf('=');
    if (eq < 1) throw new Error(`parameter "${text}" must be name=value`);
    return { name: text.slice(0, eq), value: text.slice(eq + 1) };
  }

  function parseTemplateRef(text) {
    const slash = text.indexOf('/');
    if (slash < 1 || slash === text.length - 1) throw new Error(`--from "${text}" must be workflowtemplate/<name>`);
    const kind = text.slice(0, slash);
    if (!TEMPLATE_KINDS.test(kind)) throw new Error(`only workflowtemplate is supported (got "${kind}")`);
    return text.slice(slash + 1);
  }

  function parseLine(raw) {
    let tokens = tokenize(raw);
    if (tokens[0] && tokens[0].text === 'argo') tokens = tokens.slice(1);
    if (tokens[0] && tokens[0].text === 'submit') tokens = tokens.slice(1);

    let template = null;
    const params = [];
    const unresolved = [];
    const need = (i, flag) => {
      if (i >= tokens.length) throw new Error(`${flag} needs a value`);
    };
    const unresolvedIn = tok => { if (tok.shellVar) unresolved.push(tok.text); };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].text;
      let flag = t;
      let inline = null;
      const m = /^(--[a-z-]+)=(.*)$/s.exec(t);
      if (m) { flag = m[1]; inline = m[2]; }

      if (flag === '--from') {
        if (template) throw new Error('--from given more than once');
        if (inline == null) need(++i, flag);
        unresolvedIn(tokens[i]);
        template = parseTemplateRef(inline ?? tokens[i].text);
      } else if (flag === '-p' || flag === '--parameter') {
        if (inline == null) need(++i, flag);
        unresolvedIn(tokens[i]);
        params.push(parseParam(inline ?? tokens[i].text));
      } else if (IGNORED_FLAGS.has(flag)) {
        // the bulk runner always waits for each workflow, so these are no-ops
      } else if (flag === '-n' || flag === '--namespace') {
        throw new Error('namespace comes from the page; remove -n/--namespace');
      } else if (flag.startsWith('-')) {
        throw new Error(`unsupported flag ${flag}`);
      } else {
        throw new Error(`unexpected argument "${t}"`);
      }
    }
    if (!template) throw new Error('missing --from workflowtemplate/<name>');
    return { template, params, unresolved };
  }

  // Joins `\`-continued lines -> [{ lineNo, text }], lineNo being the line each logical line starts on.
  function logicalLines(text) {
    const logical = [];
    let pending = null;
    text.split(/\r?\n/).forEach((raw, idx) => {
      const start = pending ? pending.lineNo : idx + 1;
      const joined = pending ? `${pending.text} ${raw}` : raw;
      if (/\\\s*$/.test(raw) && !/^\s*#/.test(joined)) pending = { lineNo: start, text: joined.replace(/\\\s*$/, '') };
      else { pending = null; logical.push({ lineNo: start, text: joined }); }
    });
    if (pending) logical.push(pending);
    return logical;
  }

  // -> [{ lineNo, raw, template, params, errors[] }]
  function parseLogical(logical) {
    const items = [];
    logical.forEach(({ lineNo, text: raw }) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const item = { lineNo, raw: trimmed, template: null, params: [], errors: [] };
      try {
        const r = parseLine(trimmed);
        item.template = r.template;
        item.params = r.params;
        if (r.unresolved.length) {
          item.errors.push(`unresolved variable in ${r.unresolved.map(u => `"${u}"`).join(', ')}`);
        }
      } catch (e) {
        item.errors.push(e.message);
      }
      items.push(item);
    });
    return items;
  }

  const parseBulk = text => parseLogical(logicalLines(text));

  // $region / ${region} and $cluster / $clusterName (and braced forms) are filled from the pickers.
  const PICKER_VAR = /\$\{(region|cluster|clusterName)\}|\$(clusterName|cluster|region)(?![A-Za-z0-9_])/g;

  // Which picker variables the text mentions: a Set of 'region' and/or 'cluster'.
  function usedPickerVars(text) {
    const used = new Set();
    for (const m of text.matchAll(PICKER_VAR)) used.add((m[1] || m[2]) === 'region' ? 'region' : 'cluster');
    return used;
  }

  // Stable: items matching `re` first, everything else keeps its original order.
  const matchingFirst = (list, re) => [...list].sort((a, b) => re.test(b) - re.test(a));

  // East regions always go first, and orch clusters go first within each region.
  const sortRegions = regions => matchingFirst(regions, /east/);
  const sortClusters = clusters => matchingFirst(clusters, /orch/);

  // Expands the text once per selected region x cluster, but each line only loops over the variables it
  // actually uses: a line with just $region runs once per region, one with neither runs once in total.
  // Order: for each region, for each cluster, the lines due for that target - so the lines for one target
  // stay together and run before the next target starts (a line that is not per-cluster runs with the
  // first cluster of each region).
  // A used variable with nothing selected is left in place and reported as unresolved by parseBulk.
  function expandBulk(text, { regions = [], clusters = [] } = {}) {
    const lines = logicalLines(text).map(line => ({ line, used: usedPickerVars(line.text) }));
    const anyUsed = new Set(lines.flatMap(({ used }) => [...used]));
    const rs = anyUsed.has('region') && regions.length ? regions : [null];
    const cs = anyUsed.has('cluster') && clusters.length ? clusters : [null];
    const done = new Set();
    const items = [];
    for (const region of rs) {
      for (const cluster of cs) {
        for (const { line, used } of lines) {
          const r = used.has('region') ? region : null;
          const c = used.has('cluster') ? cluster : null;
          const key = `${line.lineNo}\0${r}\0${c}`;
          if (done.has(key)) continue;
          done.add(key);
          const filled = line.text.replace(PICKER_VAR, (whole, braced, bare) => {
            const v = (braced || bare) === 'region' ? r : c;
            return v ?? whole;
          });
          for (const item of parseLogical([{ lineNo: line.lineNo, text: filled }])) items.push({ ...item, region: r, cluster: c });
        }
      }
    }
    return items;
  }

  // Picker choices from the WorkflowTemplate list: the first template that carries a clusterName enum
  // (region enum taken from the same template). null if none does.
  function targetsFromTemplates(templates) {
    for (const t of templates || []) {
      const params = t?.spec?.arguments?.parameters || [];
      const enumOf = name => (params.find(p => p.name === name)?.enum || []).map(String);
      const clusters = enumOf('clusterName');
      if (clusters.length) return { source: t.metadata?.name || '', regions: sortRegions(enumOf('region')), clusters: sortClusters(clusters) };
    }
    return null;
  }

  const api = { parseBulk, expandBulk, usedPickerVars, sortRegions, sortClusters, targetsFromTemplates, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArgoBulkParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
