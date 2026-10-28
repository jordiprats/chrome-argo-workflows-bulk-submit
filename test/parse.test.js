const test = require('node:test');
const assert = require('node:assert');
const { parseBulk, expandBulk, usedPickerVars, sortRegions, sortClusters, targetsFromTemplates } = require('../extension/parse.js');

test('example lines from the request, with variables filled in', () => {
  const items = parseBulk(`
--from workflowtemplate/helm-create-kyverno -p region=us-west-2 -p clusterName=c1 -p dryRun=false
--from workflowtemplate/helm-create-kyverno-addons -p region=us-west-2 -p clusterName=c1 -p dryRun=false
`);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].errors, []);
  assert.equal(items[0].template, 'helm-create-kyverno');
  assert.deepEqual(items[0].params, [
    { name: 'region', value: 'us-west-2' },
    { name: 'clusterName', value: 'c1' },
    { name: 'dryRun', value: 'false' },
  ]);
  assert.equal(items[1].template, 'helm-create-kyverno-addons');
});

test('unresolved shell variables are errors', () => {
  const [it] = parseBulk('--from workflowtemplate/x -p region=$region -p c=${cluster}');
  assert.equal(it.errors.length, 1);
  assert.match(it.errors[0], /unresolved/);
});

test('single-quoted $ is literal, double-quoted is not', () => {
  assert.deepEqual(parseBulk("--from workflowtemplate/x -p a='$HOME'")[0].errors, []);
  assert.equal(parseBulk('--from workflowtemplate/x -p a="$HOME"')[0].errors.length, 1);
});

test('forms: argo submit prefix, =, long flags, quotes, = inside value, continuation, comments', () => {
  const items = parseBulk(`# comment
argo submit --from=wftmpl/a --parameter=k=v -p "x=a b" -p 'y=1=2' --wait
--from workflowtemplate/b \\
  -p z=1
`);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].errors, []);
  assert.equal(items[0].template, 'a');
  assert.deepEqual(items[0].params, [
    { name: 'k', value: 'v' }, { name: 'x', value: 'a b' }, { name: 'y', value: '1=2' },
  ]);
  assert.equal(items[1].template, 'b');
  assert.equal(items[1].lineNo, 3); // line the command starts on, not where the continuation ends
  assert.deepEqual(items[1].params, [{ name: 'z', value: '1' }]);
});

test('errors', () => {
  const e = s => parseBulk(s)[0].errors[0];
  assert.match(e('-p a=b'), /missing --from/);
  assert.match(e('--from cronworkflow/x'), /only workflowtemplate/);
  assert.match(e('--from x'), /workflowtemplate\/<name>/);
  assert.match(e('--from workflowtemplate/x -p novalue'), /name=value/);
  assert.match(e('--from workflowtemplate/x -n foo'), /namespace comes from the page/);
  assert.match(e('--from workflowtemplate/x --bogus'), /unsupported flag/);
  assert.match(e('--from workflowtemplate/x -p'), /needs a value/);
  assert.match(e('--from workflowtemplate/x -p "a=b'), /unterminated/);
});

test('expandBulk: region x cluster, lines stay together per target', () => {
  const text = `--from workflowtemplate/a -p region=$region -p clusterName=$cluster
--from workflowtemplate/b -p region=\${region} -p clusterName=$clusterName`;
  const items = expandBulk(text, { regions: ['r1'], clusters: ['c1', 'c2'] });
  assert.deepEqual(items.map(i => [i.template, i.params[1].value, i.cluster, i.region]), [
    ['a', 'c1', 'c1', 'r1'], ['b', 'c1', 'c1', 'r1'], ['a', 'c2', 'c2', 'r1'], ['b', 'c2', 'c2', 'r1'],
  ]);
  assert.ok(items.every(i => i.errors.length === 0));
  assert.equal(items[2].lineNo, 1);
});

test('expandBulk: lines without $cluster (or $region) do not loop over it', () => {
  const text = `--from workflowtemplate/ecr -p region=$region -p dryRun=false
--from workflowtemplate/a -p region=$region -p clusterName=$cluster
--from workflowtemplate/once -p dryRun=false`;
  const items = expandBulk(text, { regions: ['r1', 'r2'], clusters: ['c1', 'c2'] });
  assert.deepEqual(items.map(i => [i.template, i.region, i.cluster]), [
    ['ecr', 'r1', null], ['a', 'r1', 'c1'], ['once', null, null], ['a', 'r1', 'c2'],
    ['ecr', 'r2', null], ['a', 'r2', 'c1'], ['a', 'r2', 'c2'],
  ]);
  assert.ok(items.every(i => i.errors.length === 0));
});

test('expandBulk: $cluster is not a prefix match of $clusterName, nor of $clusterNameX', () => {
  const [ok] = expandBulk('--from workflowtemplate/a -p x=$clusterName', { clusters: ['c1'] });
  assert.equal(ok.params[0].value, 'c1');
  const [bad] = expandBulk('--from workflowtemplate/a -p x=$clusterNameX', { clusters: ['c1'] });
  assert.match(bad.errors[0], /unresolved/);
});

test('expandBulk: unused selections do not multiply; used-but-unselected stays unresolved', () => {
  const noVars = expandBulk('--from workflowtemplate/a -p clusterName=fixed', { regions: ['r1', 'r2'], clusters: ['c1', 'c2'] });
  assert.equal(noVars.length, 1);
  assert.equal(noVars[0].cluster, null);
  const onlyCluster = expandBulk('--from workflowtemplate/a -p c=$cluster', { regions: ['r1', 'r2'], clusters: ['c1'] });
  assert.equal(onlyCluster.length, 1);
  const none = expandBulk('--from workflowtemplate/a -p c=$cluster', { clusters: [] });
  assert.match(none[0].errors[0], /unresolved/);
});

test('targetsFromTemplates: first template with a clusterName enum, enums stringified', () => {
  const tmpl = (name, params) => ({ metadata: { name }, spec: { arguments: { parameters: params } } });
  const got = targetsFromTemplates([
    tmpl('helm-create-no-enum', [{ name: 'clusterName', value: 'x' }]),
    tmpl('helm-create-fluent-bit', [
      { name: 'region', enum: ['us-west-2'] },
      { name: 'clusterName', enum: ['ecomm-eks-v2-a', 'ecomm-eks-v2-b'] },
      { name: 'dryRun', enum: [true, false] },
    ]),
    tmpl('helm-create-other', [{ name: 'clusterName', enum: ['zzz'] }]),
  ]);
  assert.deepEqual(got, { source: 'helm-create-fluent-bit', regions: ['us-west-2'], clusters: ['ecomm-eks-v2-a', 'ecomm-eks-v2-b'] });
  assert.equal(targetsFromTemplates([]), null);
  assert.equal(targetsFromTemplates(undefined), null);
});

test('east regions sort first, the rest keep template order; targetsFromTemplates applies it', () => {
  assert.deepEqual(sortRegions(['us-west-2', 'us-east-1']), ['us-east-1', 'us-west-2']);
  assert.deepEqual(sortRegions(['eu-west-1', 'us-west-2', 'us-east-2', 'us-east-1']), ['us-east-2', 'us-east-1', 'eu-west-1', 'us-west-2']);
  const got = targetsFromTemplates([{ metadata: { name: 't' }, spec: { arguments: { parameters: [
    { name: 'region', enum: ['us-west-2', 'us-east-1'] }, { name: 'clusterName', enum: ['c'] }] } } }]);
  assert.deepEqual(got.regions, ['us-east-1', 'us-west-2']);
});

test('usedPickerVars', () => {
  assert.deepEqual([...usedPickerVars('-p a=$region -p b=${clusterName}')].sort(), ['cluster', 'region']);
  assert.equal(usedPickerVars('-p a=$regionX').size, 0);
});

test('orch clusters sort first, the rest keep template order', () => {
  const tpl = ['ecomm-eks-v2-a', 'ecomm-eks-v2-b', 'ecomm-eks-payments-v2-a', 'ecomm-eks-payments-v2-b', 'ecomm-eks-orch-v2-a', 'ecomm-eks-orch-v2-b'];
  assert.deepEqual(sortClusters(tpl), ['ecomm-eks-orch-v2-a', 'ecomm-eks-orch-v2-b', 'ecomm-eks-v2-a', 'ecomm-eks-v2-b', 'ecomm-eks-payments-v2-a', 'ecomm-eks-payments-v2-b']);
  const got = targetsFromTemplates([{ metadata: { name: 't' }, spec: { arguments: { parameters: [{ name: 'clusterName', enum: tpl }] } } }]);
  assert.deepEqual(got.clusters, sortClusters(tpl));
});
