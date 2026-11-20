const test = require('node:test');
const assert = require('node:assert/strict');
const { pglite, migrate } = require('../src/db');
const { createEngine } = require('../src/engine');
const { load } = require('../src/config');
const { buildApp } = require('../src/server');
const { fakeItsm } = require('../src/adapters/fake/itsm');
const { fakeHypervisor } = require('../src/adapters/fake/hypervisor');
const { fakeNotifier } = require('../src/adapters/fake/notifier');

test('HTTP API: token required; a chat command starts a run; status answers', async () => {
  const db = await pglite(); await migrate(db);
  const cfg = load({ DECOM_API_TOKEN: 'secret-token', DATABASE_URL: 'x', DECOM_CONFIRMERS: 'alex' });
  const engine = createEngine({ db, itsm: fakeItsm(), hypervisor: fakeHypervisor(), notifier: fakeNotifier(), config: cfg, autoKick: false, log: { error() {} } });
  const server = buildApp({ engine, cfg, db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { Authorization: 'Bearer wrong-token!' } })).status, 401);
    const h = { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' };
    const say = await (await fetch(`${base}/api/command`, { method: 'POST', headers: h, body: JSON.stringify({ text: '@DecomBot decommission WEB-01', actor: 'pat' }) })).json();
    assert.match(say.reply, /Request received: decommission WEB-01 \(run 1\)/);
    const st = await (await fetch(`${base}/api/command`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'status WEB-01', actor: 'pat' }) })).json();
    assert.match(st.reply, /WEB-01: Checking the CMDB and vSphere/);
    const dup = await fetch(`${base}/api/requests`, { method: 'POST', headers: h, body: JSON.stringify({ server: 'web-01', actor: 'sam' }) });
    assert.equal(dup.status, 409);
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.dryRun, true, 'dry run is the default');
  } finally {
    server.close();
  }
});
