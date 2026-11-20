const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDecomIntent, extractStatusIntent } = require('../src/grammar');

test('requests', () => {
  assert.deepEqual(extractDecomIntent('decommission DECOM-TEST-29'), { hostname: 'DECOM-TEST-29' });
  assert.deepEqual(extractDecomIntent('@DecomBot please decommission server WIN2K8'), { hostname: 'WIN2K8' });
  assert.deepEqual(extractDecomIntent('I think we should decommission web-01.'), { hostname: 'web-01' });
  assert.equal(extractDecomIntent('the decommission today went fine'), null);
  assert.equal(extractDecomIntent('pre-decommission web-01'), null);
  assert.equal(extractDecomIntent('decommission status'), null);
});

test('status', () => {
  assert.deepEqual(extractStatusIntent('status CHG0030001'), { query: 'CHG0030001' });
  assert.deepEqual(extractStatusIntent('@DecomBot status of DECOM-TEST-29?'), { query: 'DECOM-TEST-29' });
  assert.deepEqual(extractStatusIntent('status'), { help: true });
  assert.equal(extractStatusIntent('what is the status of the project'), null);
});
