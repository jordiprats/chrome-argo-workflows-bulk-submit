const test = require('node:test');
const assert = require('node:assert');

// lib.js is an ES module; load it dynamically from this CommonJS test.
const load = () => import('../extension/lib.js');

test('normalise adds the Bearer prefix once', async () => {
  const { normalise } = await load();
  assert.equal(normalise('v2:abc.def'), 'Bearer v2:abc.def');
  assert.equal(normalise('Bearer v2:abc.def'), 'Bearer v2:abc.def');
  assert.equal(normalise('bearer v2:abc.def'), 'bearer v2:abc.def');
});

test('normalise decodes URL-encoded values', async () => {
  const { normalise } = await load();
  assert.equal(normalise('Bearer%20v2%3Aabc.def'), 'Bearer v2:abc.def');
});

test('normalise strips the double quotes around a quoted cookie', async () => {
  const { normalise } = await load();
  assert.equal(normalise('"Bearer v2:abc.def"'), 'Bearer v2:abc.def');
  assert.equal(normalise('%22Bearer%20v2%3Aabc.def%22'), 'Bearer v2:abc.def');
  assert.equal(normalise('Bearer "Bearer v2:abc.def"'), 'Bearer v2:abc.def');
  assert.equal(normalise('"v2:abc.def"'), 'Bearer v2:abc.def');
});
