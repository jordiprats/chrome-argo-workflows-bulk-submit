const test = require('node:test');
const assert = require('node:assert');
const {
  runCommand, normaliseCommand, parseInput, parseLogStream, stderrFromLog, artifactNodeId,
  parseNsCommand, parseNamespaceList, hasNamespaceFlag, withNamespace, wordLeft, wordRight,
} = require('../extension/shell.js');

test('wordLeft/wordRight move by whitespace-separated words like a shell', () => {
  const t = 'get pods  -n  kube-system';
  assert.equal(wordLeft(t, t.length), 14); // start of "kube-system"
  assert.equal(wordLeft(t, 14), 10); // start of "-n"
  assert.equal(wordLeft(t, 12), 10); // from inside a word to its start
  assert.equal(wordLeft(t, 3), 0);
  assert.equal(wordLeft(t, 0), 0);
  assert.equal(wordRight(t, 0), 3); // end of "get"
  assert.equal(wordRight(t, 3), 8); // end of "pods"
  assert.equal(wordRight(t, 9), 12); // skips the gap, ends "-n"
  assert.equal(wordRight(t, 15), t.length);
  assert.equal(wordRight(t, t.length), t.length);
  assert.equal(wordLeft('', 0), 0);
  assert.equal(wordRight('', 0), 0);
});

test('kubectl prefix is optional', () => {
  assert.equal(normaliseCommand('get pods -A'), 'kubectl get pods -A');
  assert.equal(normaliseCommand('  kubectl get ns '), 'kubectl get ns');
  assert.equal(normaliseCommand('kubectl'), 'kubectl');
  assert.equal(normaliseCommand('kubectlfoo bar'), 'kubectl kubectlfoo bar');
  assert.equal(normaliseCommand('   '), '');
});

test('k is an alias for kubectl and is sent as kubectl', () => {
  assert.equal(normaliseCommand('k get pods'), 'kubectl get pods');
  assert.equal(normaliseCommand('  k   get pods -A '), 'kubectl   get pods -A');
  assert.equal(normaliseCommand('k'), 'kubectl');
  assert.equal(normaliseCommand('kget pods'), 'kubectl kget pods');
});

test('log stream: JSON lines are unwrapped, plain lines kept', () => {
  const text = '{"result":{"content":"a","podName":"p"}}\n\nplain\n{"result":{"content":"b"}}\n';
  assert.deepEqual(parseLogStream(text), ['a', 'plain', 'b']);
});

test('stderr is what follows the COMMAND line, minus the set -v echo of eval', () => {
  const lines = ['set -ev', 'lots of init noise', 'COMMAND: kubectl get nope', 'eval "$COMMAND > $OUTPUT_PATH"',
    'error: the server doesn\'t have a resource type "nope"'];
  assert.equal(stderrFromLog(lines), 'error: the server doesn\'t have a resource type "nope"');
});

test('stderr: validation failures never reach the COMMAND line', () => {
  const lines = ['set -ev', 'noise', 'Command is invalid. Must begin with \'kubectl \'', 'more noise'];
  assert.equal(stderrFromLog(lines), 'Command is invalid. Must begin with \'kubectl \'');
});

test('artifact node is found by artifact name', () => {
  const wf = { status: { nodes: { a: { id: 'a' }, b: { id: 'b', outputs: { artifacts: [{ name: 'kubectl-output' }] } } } } };
  assert.equal(artifactNodeId(wf), 'b');
  assert.equal(artifactNodeId({}), null);
});

test('lines starting with aws go to admin-aws, the rest to kubectl', () => {
  assert.deepEqual(parseInput('aws s3 ls'), { tool: 'aws', command: 'aws s3 ls' });
  assert.deepEqual(parseInput('  aws   sts get-caller-identity '), { tool: 'aws', command: 'aws   sts get-caller-identity' });
  assert.deepEqual(parseInput('aws'), { tool: 'aws', command: 'aws' });
  assert.deepEqual(parseInput('k get pods'), { tool: 'kubectl', command: 'kubectl get pods' });
  assert.deepEqual(parseInput('get pods'), { tool: 'kubectl', command: 'kubectl get pods' });
  assert.deepEqual(parseInput('awsfoo'), { tool: 'kubectl', command: 'kubectl awsfoo' });
});

test('ns command: show, set, clear', () => {
  assert.deepEqual(parseNsCommand('ns'), { action: 'show' });
  assert.deepEqual(parseNsCommand('  ns  '), { action: 'show' });
  assert.deepEqual(parseNsCommand('ns kube-system'), { action: 'set', value: 'kube-system' });
  assert.deepEqual(parseNsCommand('ns 2'), { action: 'set', value: '2' });
  assert.deepEqual(parseNsCommand('ns -'), { action: 'clear' });
  assert.deepEqual(parseNsCommand('ns none'), { action: 'clear' });
  assert.deepEqual(parseNsCommand('ns default'), { action: 'clear' });
  assert.deepEqual(parseNsCommand('ns DEFAULT'), { action: 'clear' });
  assert.equal(parseNsCommand('get pods'), null);
  assert.equal(parseNsCommand('nsfoo'), null);
  assert.equal(parseNsCommand('ns a b'), null);
});

test('ns command also recognised as "kubectl ns" / "k ns" - never sent to kubectl itself', () => {
  assert.deepEqual(parseNsCommand('kubectl ns'), { action: 'show' });
  assert.deepEqual(parseNsCommand('k ns'), { action: 'show' });
  assert.deepEqual(parseNsCommand('kubectl ns kube-system'), { action: 'set', value: 'kube-system' });
  assert.deepEqual(parseNsCommand('k ns -'), { action: 'clear' });
  // "kns" / "kubectlns" are not the alias followed by "ns" - not recognised.
  assert.equal(parseNsCommand('kns'), null);
  assert.equal(parseNsCommand('kubectlns'), null);
});

test('parseNamespaceList splits one name per line and drops blanks', () => {
  assert.deepEqual(parseNamespaceList('default\nkube-system\n\n  argo  \n'), ['default', 'kube-system', 'argo']);
  assert.deepEqual(parseNamespaceList(''), []);
  assert.deepEqual(parseNamespaceList(null), []);
});

test('hasNamespaceFlag spots -n/--namespace and -A/--all-namespaces', () => {
  assert.equal(hasNamespaceFlag('kubectl -n kube-system get pods'), true);
  assert.equal(hasNamespaceFlag('kubectl get pods --namespace=kube-system'), true);
  assert.equal(hasNamespaceFlag('kubectl get pods -A'), true);
  assert.equal(hasNamespaceFlag('kubectl get pods --all-namespaces'), true);
  assert.equal(hasNamespaceFlag('kubectl get pods'), false);
  assert.equal(hasNamespaceFlag('kubectl get pods --name foo'), false); // not a namespace flag
});

test('withNamespace inserts -n right after kubectl, unless already namespaced or unset', () => {
  assert.equal(withNamespace('kubectl get pods', 'kube-system'), 'kubectl -n kube-system get pods');
  assert.equal(withNamespace('kubectl get pods', ''), 'kubectl get pods');
  assert.equal(withNamespace('kubectl -n other get pods', 'kube-system'), 'kubectl -n other get pods');
  assert.equal(withNamespace('kubectl get pods -A', 'kube-system'), 'kubectl get pods -A');
  assert.equal(withNamespace('kubectl', 'kube-system'), 'kubectl -n kube-system');
});

test('withNamespace applies to every kubectl in a pipeline, each judged on its own', () => {
  // the case from the bug report: the xargs'd kubectl must get it too, and the JSON payload is left alone
  assert.equal(
    withNamespace(`kubectl get workflow -o name | xargs -I{} kubectl patch {} --type=merge -p '{"metadata":{"finalizers":null}}'`, 'argo'),
    `kubectl -n argo get workflow -o name | xargs -I{} kubectl -n argo patch {} --type=merge -p '{"metadata":{"finalizers":null}}'`);
  assert.equal(withNamespace('kubectl get pods && kubectl get svc; kubectl get cm', 'x'),
    'kubectl -n x get pods && kubectl -n x get svc; kubectl -n x get cm');
  assert.equal(withNamespace('kubectl get pods || kubectl get svc', 'x'), 'kubectl -n x get pods || kubectl -n x get svc');
  assert.equal(withNamespace('kubectl get pods | grep Running', 'x'), 'kubectl -n x get pods | grep Running');
  assert.equal(withNamespace('FOO=1 kubectl get pods', 'x'), 'FOO=1 kubectl -n x get pods');
  assert.equal(withNamespace('kubectl delete $(kubectl get pods -o name)', 'x'),
    'kubectl -n x delete $(kubectl -n x get pods -o name)');
  // one kubectl having -n / -A doesn't stop the others
  assert.equal(withNamespace('kubectl get pods -n a | xargs kubectl describe', 'x'),
    'kubectl get pods -n a | xargs kubectl -n x describe');
  assert.equal(withNamespace('kubectl get pods -A | xargs -n1 kubectl get', 'x'),
    'kubectl get pods -A | xargs -n1 kubectl -n x get');
  // redirections are not separators
  assert.equal(withNamespace('kubectl get pods 2>&1 -n a', 'x'), 'kubectl get pods 2>&1 -n a');
});

test('withNamespace ignores kubectl, pipes and flags inside quotes or as plain arguments', () => {
  assert.equal(withNamespace(`kubectl get pods -l 'a=b;kubectl' | wc -l`, 'x'), `kubectl -n x get pods -l 'a=b;kubectl' | wc -l`);
  assert.equal(withNamespace(`kubectl create cm c --from-literal=k="kubectl -n y"`, 'x'),
    `kubectl -n x create cm c --from-literal=k="kubectl -n y"`);
  assert.equal(withNamespace('kubectl get pods | grep kubectl', 'x'), 'kubectl -n x get pods | grep kubectl');
  assert.equal(withNamespace('kubectl get pods | xargs echo kubectl', 'x'), 'kubectl -n x get pods | xargs echo kubectl');
  // wrapper options with separate values
  assert.equal(withNamespace('echo a | xargs -I {} -P 4 kubectl get {}', 'x'), 'echo a | xargs -I {} -P 4 kubectl -n x get {}');
  assert.equal(withNamespace('timeout 30 kubectl get pods', 'x'), 'timeout 30 kubectl -n x get pods');
  assert.equal(withNamespace('watch -n 2 kubectl get pods', 'x'), 'watch -n 2 kubectl -n x get pods');
});

const makeCtx = ({ phases, artifact, log, artifactName = 'kubectl-output', wfName = 'admin-kubectl-xyz' }) => {
  const calls = [];
  let polls = 0;
  return {
    calls,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'POST') return { metadata: { name: wfName } };
      if (path.includes('fields=status.phase')) {
        const phase = phases[Math.min(polls++, phases.length - 1)];
        return { status: { phase, message: phase === 'Failed' ? 'boom' : '' } };
      }
      return { status: { nodes: { [wfName]: { id: wfName, outputs: { artifacts: [{ name: artifactName }] } } } } };
    },
    getText: async path => {
      calls.push({ path });
      if (path.includes('/log')) return log;
      if (artifact == null) throw new Error('no artifact');
      return artifact;
    },
    sleep: async () => {},
  };
};

test('runCommand submits admin-kubectl and returns the artifact', async () => {
  const ctx = makeCtx({ phases: ['Pending', 'Running', 'Succeeded'], artifact: 'NAME\npod-1\n' });
  const seen = [];
  const r = await runCommand(ctx, {
    ns: 'argo', params: { clusterName: 'c1', role: 'readonly', command: 'kubectl get pods', dryRun: 'false' },
    signal: new AbortController().signal, onPhase: p => seen.push(p),
  });
  assert.deepEqual(r, { ok: true, name: 'admin-kubectl-xyz', output: 'NAME\npod-1\n', errors: '', message: '' });
  assert.deepEqual(seen, ['submitting', 'pending', 'running']);
  const submit = ctx.calls.find(c => c.method === 'POST');
  assert.equal(submit.body.resourceName, 'admin-kubectl');
  assert.deepEqual(submit.body.submitOptions.parameters,
    ['clusterName=c1', 'role=readonly', 'command=kubectl get pods', 'dryRun=false']);
  assert.ok(ctx.calls.some(c => c.path === 'artifact-files/argo/workflows/admin-kubectl-xyz/admin-kubectl-xyz/outputs/kubectl-output'));
  assert.ok(!ctx.calls.some(c => c.path?.includes('/log')), 'log is only fetched when needed');
});

test('runCommand on failure reports the stderr from the pod log', async () => {
  const ctx = makeCtx({
    phases: ['Failed'], artifact: null,
    log: '{"result":{"content":"COMMAND: kubectl get nope"}}\n{"result":{"content":"error: bad"}}\n',
  });
  const r = await runCommand(ctx, { ns: 'argo', params: {}, signal: new AbortController().signal });
  assert.equal(r.ok, false);
  assert.equal(r.output, '');
  assert.equal(r.errors, 'error: bad');
  assert.equal(r.message, 'boom');
});

test('runCommand with tool aws submits admin-aws and reads aws-output', async () => {
  const ctx = makeCtx({ phases: ['Succeeded'], artifact: '{"Account":"1"}', artifactName: 'aws-output', wfName: 'admin-aws-abc' });
  const r = await runCommand(ctx, {
    ns: 'argo', tool: 'aws', params: { role: 'readonly', command: 'aws sts get-caller-identity', dryRun: 'false' },
    signal: new AbortController().signal,
  });
  assert.equal(r.ok, true);
  assert.equal(r.output, '{"Account":"1"}');
  assert.equal(ctx.calls.find(c => c.method === 'POST').body.resourceName, 'admin-aws');
  assert.ok(ctx.calls.some(c => c.path === 'artifact-files/argo/workflows/admin-aws-abc/admin-aws-abc/outputs/aws-output'));
});
