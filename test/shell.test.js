const test = require('node:test');
const assert = require('node:assert');
const { runCommand, normaliseCommand, parseInput, parseLogStream, stderrFromLog, artifactNodeId } = require('../extension/shell.js');

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
