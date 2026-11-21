// The workflow against fake ServiceNow / vSphere / Teams and a real (in-memory) Postgres. These carry
// over the lab's fault-injection scenarios: lost answers, double clicks, restarts mid-step, and the
// guards in front of the irreversible delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pglite, migrate } = require('../src/db');
const { createEngine, TASKS } = require('../src/engine');
const { load } = require('../src/config');
const { fakeItsm } = require('../src/adapters/fake/itsm');
const { fakeHypervisor } = require('../src/adapters/fake/hypervisor');
const { fakeNotifier } = require('../src/adapters/fake/notifier');

const HOST = { sysId: 'esx7', name: 'ESXi 7', ip: '10.0.0.65' };
const quiet = { error() {} };

async function setup(env = {}) {
  const db = await pglite();
  await migrate(db);
  const clock = { t: new Date('2026-11-20T10:00:00Z') };
  const config = load({ DECOM_DRY_RUN: 'false', DECOM_SOAK_HOURS: '24', DECOM_CONFIRMERS: 'alex,sam', ...env });
  const itsm = fakeItsm();
  const hv = fakeHypervisor();
  const notifier = fakeNotifier();
  itsm.addCi({ sysId: 'ci29', name: 'DECOM-TEST-29', ip: '10.0.0.200', uuid: 'uuid-29' }, HOST);
  hv.addVm({ name: 'DECOM-TEST-29', uuid: 'uuid-29', ip: '10.0.0.200', host: HOST.ip });
  const make = () => createEngine({ db, itsm, hypervisor: hv, notifier, config, now: () => new Date(clock.t), log: quiet, autoKick: false });
  const engine = make();
  const advanceHours = (h) => { clock.t = new Date(clock.t.getTime() + h * 3600 * 1000); };
  return { db, clock, config, itsm, hv, notifier, engine, make, advanceHours };
}

// Request and drive it to the point where it waits for the delete confirmation.
async function toConfirm(ctx, server = 'DECOM-TEST-29') {
  const { engine, itsm } = ctx;
  const run = await engine.request({ server, actor: 'pat' });
  await engine.advance(run.id);
  let r = await engine.getRun(run.id);
  assert.equal(r.state, 'awaiting_approval', JSON.stringify(r));
  itsm.approve(r.change_number);
  await engine.advance(run.id);
  r = await engine.getRun(run.id);
  assert.equal(r.state, 'prechecks');
  for (const name of TASKS.slice(0, 3)) itsm.closeTaskByName(r.change_number, name);
  await engine.advance(run.id);
  r = await engine.getRun(run.id);
  assert.equal(r.state, 'soaking');
  ctx.advanceHours(25);
  await engine.advance(run.id);
  r = await engine.getRun(run.id);
  assert.equal(r.state, 'awaiting_destroy_confirm');
  return r;
}

test('happy path: request to deleted VM, retired CI and closed change', async () => {
  const ctx = await setup();
  const r0 = await toConfirm(ctx);
  const { engine, itsm, hv } = ctx;
  assert.equal(itsm.state.cis[0].status, 'in_maintenance');
  assert.equal(hv.state.vms[0].powerState, 'poweredOff');
  await engine.confirmDestroy({ runId: r0.id, actor: 'alex' });
  await engine.advance(r0.id);
  const r = await engine.getRun(r0.id);
  assert.equal(r.state, 'completed');
  assert.equal(hv.state.vms.length, 0);
  assert.equal(itsm.state.cis[0].status, 'retired');
  assert.equal(itsm.state.changes[0].status, 'closed');
  assert.ok(itsm.state.tasks.every((t) => t.status === 'done'), 'all 7 tasks closed');
  assert.deepEqual(r.reclaimed, { cpu: 1, memoryMb: 512, diskGb: 1 });
  await engine.deliver();
  const said = ctx.notifier.sent.map((m) => m.message).join('\n');
  assert.match(said, /Request received/);
  assert.match(said, /decommissioned\. CHG\d+ closed, CI retired\. Reclaimed: 1 vCPU · 512 MB RAM · 1 GB storage/);
});

test('validation refuses: unknown, retired, never-touch, open incident, drift, ambiguous', async () => {
  const ctx = await setup({ DECOM_NEVER_TOUCH: 'CRIT-01' });
  const { engine, itsm, hv } = ctx;
  itsm.addCi({ sysId: 'ci-ret', name: 'OLD-01', status: 'retired' }, HOST);
  itsm.addCi({ sysId: 'ci-inc', name: 'BUSY-01' }, HOST); hv.addVm({ name: 'BUSY-01' }); itsm.addIncident('ci-inc', 'INC0010001');
  itsm.addCi({ sysId: 'ci-drift', name: 'DRIFT-01', uuid: 'uuid-cmdb' }, HOST); hv.addVm({ name: 'DRIFT-01', uuid: 'uuid-real' });
  itsm.addCi({ sysId: 'ci-nohost', name: 'LONELY-01' });
  itsm.addCi({ sysId: 'ci-dup1', name: 'TWIN-01' }, HOST); hv.addVm({ name: 'TWIN-01' }); hv.addVm({ name: 'TWIN-01' });
  itsm.addCi({ sysId: 'ci-crit', name: 'CRIT-01' }, HOST);
  const expect = {
    'NOPE-01': /no CMDB record/, 'OLD-01': /already retired/, 'BUSY-01': /open records: INC0010001/,
    'DRIFT-01': /disagree \(UUID/, 'LONELY-01': /no hypervisor host/, 'TWIN-01': /more than one VM/,
  };
  for (const [server, why] of Object.entries(expect)) {
    const run = await engine.request({ server, actor: 'pat' });
    await engine.advance(run.id);
    const r = await engine.getRun(run.id);
    assert.equal(r.state, 'refused', server);
    assert.match(r.outcome, why, server);
  }
  await assert.rejects(engine.request({ server: 'CRIT-01', actor: 'pat' }), /never-touch/);
  await assert.rejects(engine.request({ server: 'decom', actor: 'pat' }), /never-touch/, 'the orchestrator itself');
  assert.equal(itsm.state.changes.length, 0, 'no change for a refused request');
  assert.equal(hv.state.calls.filter((c) => c.name !== 'findVm').length, 0, 'no VM was touched');
});

test('one live decommission per server', async () => {
  const { engine } = await setup();
  await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await assert.rejects(engine.request({ server: 'decom-test-29', actor: 'sam' }), /already has a decommission in progress/);
});

test('rejected change ends the run without touching the VM or the CI', async () => {
  const { engine, itsm, hv } = await setup();
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  itsm.reject((await engine.getRun(run.id)).change_number);
  await engine.advance(run.id);
  assert.equal((await engine.getRun(run.id)).state, 'rejected');
  assert.equal(hv.state.vms[0].powerState, 'poweredOn');
  assert.equal(itsm.state.cis[0].status, 'installed');
});

test('power-off waits for all three pre-checks; skip needs a reason', async () => {
  const { engine, itsm, hv } = await setup();
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  itsm.approve((await engine.getRun(run.id)).change_number);
  await engine.advance(run.id);
  await engine.precheck({ runId: run.id, task: 1, outcome: 'done', actor: 'pat' });
  await assert.rejects(engine.precheck({ runId: run.id, task: 2, outcome: 'skip', actor: 'pat' }), /needs a reason/);
  await engine.precheck({ runId: run.id, task: 2, outcome: 'skip', actor: 'pat', reason: 'not monitored' });
  await engine.advance(run.id);
  assert.equal((await engine.getRun(run.id)).state, 'prechecks');
  assert.equal(hv.state.vms[0].powerState, 'poweredOn', 'still on with one pre-check open');
  await assert.rejects(engine.precheck({ runId: run.id, task: 1, outcome: 'done', actor: 'pat' }), /already done/);
  await engine.precheck({ runId: run.id, task: 'DNS / firewall cleanup', outcome: 'done', actor: 'pat' });
  await engine.advance(run.id);
  assert.equal((await engine.getRun(run.id)).state, 'soaking');
  assert.equal(hv.state.calls.filter((c) => c.name === 'shutdown').length, 1);
  assert.equal(itsm.state.tasks.find((t) => t.name === 'Remove from monitoring').status, 'skipped');
});

test('who may confirm: a listed confirmer who is not the requester; two confirms race, one wins', async () => {
  const ctx = await setup();
  const r = await toConfirm(ctx);
  const { engine, hv } = ctx;
  await assert.rejects(engine.confirmDestroy({ runId: r.id, actor: 'pat' }), /not allowed/);
  ctx.config.confirmers.push('pat');
  await assert.rejects(engine.confirmDestroy({ runId: r.id, actor: 'pat' }), /requested a decommission cannot confirm/);
  const results = await Promise.allSettled([engine.confirmDestroy({ runId: r.id, actor: 'alex' }), engine.confirmDestroy({ runId: r.id, actor: 'sam' })]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  await engine.advance(r.id);
  assert.equal(hv.state.calls.filter((c) => c.name === 'destroy').length, 1);
});

test('the delete is refused if the soak period is not over, even when the state says destroying', async () => {
  const ctx = await setup();
  const r = await toConfirm(ctx);
  const { engine, db, hv } = ctx;
  await db.query(`UPDATE decom_runs SET soak_ends_at = $2, destroy_confirmed_by = 'alex', state = 'destroying' WHERE id = $1`, [r.id, new Date('2030-01-01')]);
  await engine.advance(r.id);
  const after = await engine.getRun(r.id);
  assert.match(after.attention, /soak period is not over/);
  assert.equal(hv.state.vms.length, 1);
});

test('a VM someone powered on during the soak period is not deleted', async () => {
  const ctx = await setup();
  const r = await toConfirm(ctx);
  ctx.hv.state.vms[0].powerState = 'poweredOn';
  await ctx.engine.confirmDestroy({ runId: r.id, actor: 'alex' });
  await ctx.engine.advance(r.id);
  assert.match((await ctx.engine.getRun(r.id)).attention, /someone started it/);
  assert.equal(ctx.hv.state.vms.length, 1);
});

test('lost answers: shutdown and delete that happened although the call failed count as done', async () => {
  const ctx = await setup();
  ctx.hv.state.loseAnswer.shutdown = true;
  const r = await toConfirm(ctx);
  ctx.hv.state.loseAnswer.destroy = true;
  await ctx.engine.confirmDestroy({ runId: r.id, actor: 'alex' });
  await ctx.engine.advance(r.id);
  assert.equal((await ctx.engine.getRun(r.id)).state, 'completed');
});

test('a failed shutdown waits for a person and is not retried by the scheduler', async () => {
  const ctx = await setup();
  const { engine, itsm, hv } = ctx;
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  itsm.approve((await engine.getRun(run.id)).change_number);
  await engine.advance(run.id);
  for (const name of TASKS.slice(0, 3)) itsm.closeTaskByName((await engine.getRun(run.id)).change_number, name);
  hv.state.failNext.shutdown = new Error('Current license prohibits this operation');
  await engine.advance(run.id);
  let r = await engine.getRun(run.id);
  assert.equal(r.state, 'powering_off');
  assert.match(r.attention, /license/);
  ctx.advanceHours(1);
  await engine.tick();
  assert.equal(hv.state.calls.filter((c) => c.name === 'shutdown').length, 1, 'no automatic retry');
  await assert.rejects(engine.retry({ runId: run.id, actor: 'pat' }), /may not retry/);
  await engine.retry({ runId: run.id, actor: 'alex' });
  await engine.advance(run.id);
  r = await engine.getRun(run.id);
  assert.equal(r.state, 'soaking');
});

test('restart after the change was created but before it was saved: no second change', async () => {
  const ctx = await setup();
  ctx.itsm.state.loseCreateAnswer = true;
  const run = await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await ctx.engine.advance(run.id);
  assert.equal((await ctx.engine.getRun(run.id)).state, 'creating_change');
  const restarted = ctx.make(); // a new process
  ctx.advanceHours(0.1);
  await restarted.tick();
  const r = await restarted.getRun(run.id);
  assert.equal(r.state, 'awaiting_approval');
  assert.equal(ctx.itsm.state.changes.length, 1);
});

test('an incident during the soak period powers the VM back on and holds; cancel restores everything', async () => {
  const ctx = await setup();
  const { engine, itsm, hv } = ctx;
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  itsm.approve((await engine.getRun(run.id)).change_number);
  await engine.advance(run.id);
  for (const name of TASKS.slice(0, 3)) itsm.closeTaskByName((await engine.getRun(run.id)).change_number, name);
  await engine.advance(run.id);
  ctx.advanceHours(2);
  itsm.addIncident('ci29', 'INC0010042', new Date(ctx.clock.t));
  await engine.advance(run.id);
  let r = await engine.getRun(run.id);
  assert.equal(r.state, 'on_hold');
  assert.equal(hv.state.vms[0].powerState, 'poweredOn');
  await engine.cancel({ runId: run.id, actor: 'pat', reason: 'app team still needs it' });
  await engine.advance(run.id);
  r = await engine.getRun(run.id);
  assert.equal(r.state, 'cancelled');
  assert.equal(itsm.state.cis[0].status, 'installed');
  assert.equal(itsm.state.changes[0].status, 'cancelled');
});

test('cancel during the soak period powers the VM back on', async () => {
  const ctx = await setup();
  const r = await toConfirm(ctx);
  await ctx.engine.cancel({ runId: r.id, actor: 'alex' });
  await ctx.engine.advance(r.id);
  assert.equal((await ctx.engine.getRun(r.id)).state, 'cancelled');
  assert.equal(ctx.hv.state.vms[0].powerState, 'poweredOn');
  assert.equal(ctx.itsm.state.cis[0].status, 'installed');
});

test('dry run: everything except the delete, then the VM is back on and the CI restored', async () => {
  const ctx = await setup({ DECOM_DRY_RUN: 'true' });
  const r = await toConfirm(ctx);
  await ctx.engine.confirmDestroy({ runId: r.id, actor: 'alex' });
  await ctx.engine.advance(r.id);
  const done = await ctx.engine.getRun(r.id);
  assert.equal(done.state, 'completed');
  assert.match(done.outcome, /Dry run/);
  assert.equal(ctx.hv.state.vms.length, 1);
  assert.equal(ctx.hv.state.vms[0].powerState, 'poweredOn');
  assert.equal(ctx.hv.state.calls.filter((c) => c.name === 'destroy').length, 0);
  assert.equal(ctx.itsm.state.cis[0].status, 'installed');
});

test('messages are kept in order and retried until Teams accepts them', async () => {
  const ctx = await setup();
  await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await ctx.engine.advance(1);
  ctx.notifier.failTimes(2);
  await ctx.engine.deliver();
  assert.equal(ctx.notifier.sent.length, 0);
  ctx.advanceHours(1); await ctx.engine.deliver();
  ctx.advanceHours(1); await ctx.engine.deliver();
  assert.equal(ctx.notifier.sent.length, 2);
  assert.match(ctx.notifier.sent[0].message, /Request received/);
  assert.match(ctx.notifier.sent[1].message, /created to decommission/);
});

test('a change cancelled in ServiceNow during pre-checks puts the CI back', async () => {
  const { engine, itsm } = await setup();
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  const number = (await engine.getRun(run.id)).change_number;
  itsm.approve(number);
  await engine.advance(run.id);
  itsm.cancelExternally(number);
  await engine.advance(run.id);
  assert.equal((await engine.getRun(run.id)).state, 'cancelled');
  assert.equal(itsm.state.cis[0].status, 'installed');
});

// ---- review fixes (0.1.4) ----

test('dry run is fixed when the run is requested: turning it off later still deletes nothing', async () => {
  const ctx = await setup({ DECOM_DRY_RUN: 'true' });
  const r = await toConfirm(ctx);
  assert.equal(r.dry_run, true);
  ctx.config.dryRun = false; // the operator changes the setting mid-run
  await ctx.engine.confirmDestroy({ runId: r.id, actor: 'alex' });
  await ctx.engine.advance(r.id);
  const done = await ctx.engine.getRun(r.id);
  assert.match(done.outcome, /Dry run/);
  assert.equal(ctx.hv.state.vms.length, 1, 'VM not deleted');
  assert.equal(ctx.itsm.state.cis[0].status, 'installed', 'CI not retired');
  // and the reverse: a real run stays real when dry run is switched on
  const ctx2 = await setup({ DECOM_DRY_RUN: 'false' });
  const r2 = await toConfirm(ctx2);
  ctx2.config.dryRun = true;
  await ctx2.engine.confirmDestroy({ runId: r2.id, actor: 'alex' });
  await ctx2.engine.advance(r2.id);
  assert.equal(ctx2.hv.state.vms.length, 0, 'VM deleted');
  assert.equal(ctx2.itsm.state.cis[0].status, 'retired');
});

test('a VM that was off before the decommission is never powered on by cancel, dry run or an incident', async () => {
  for (const ending of ['cancel', 'dry run', 'incident']) {
    const ctx = await setup({ DECOM_DRY_RUN: ending === 'dry run' ? 'true' : 'false' });
    ctx.hv.state.vms[0].powerState = 'poweredOff';
    const { engine, itsm, hv } = ctx;
    const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
    await engine.advance(run.id);
    itsm.approve((await engine.getRun(run.id)).change_number);
    await engine.advance(run.id);
    for (const name of TASKS.slice(0, 3)) itsm.closeTaskByName((await engine.getRun(run.id)).change_number, name);
    await engine.advance(run.id);
    assert.equal(hv.state.calls.filter((c) => c.name === 'shutdown').length, 0, 'already off: no shutdown sent');
    if (ending === 'incident') {
      itsm.addIncident('ci29', 'INC0010077', new Date(ctx.clock.t.getTime() + 1000));
      ctx.advanceHours(1);
      await engine.advance(run.id);
      const held = await engine.getRun(run.id);
      assert.equal(held.state, 'on_hold');
      assert.match(held.attention, /left off, as it was off before/);
    } else if (ending === 'cancel') {
      await engine.cancel({ runId: run.id, actor: 'pat' });
      await engine.advance(run.id);
      assert.match((await engine.getRun(run.id)).outcome, /left off/);
    } else {
      ctx.advanceHours(25);
      await engine.advance(run.id);
      await engine.confirmDestroy({ runId: run.id, actor: 'alex' });
      await engine.advance(run.id);
      assert.equal((await engine.getRun(run.id)).state, 'completed');
    }
    assert.equal(hv.state.vms[0].powerState, 'poweredOff', `${ending}: still off`);
    assert.equal(hv.state.calls.filter((c) => c.name === 'powerOn').length, 0, `${ending}: no power-on`);
  }
});

test('a cancel that races with change creation still cancels the change in ServiceNow', async () => {
  const ctx = await setup();
  ctx.itsm.state.loseCreateAnswer = true; // the change is made, but the run never hears its number
  const run = await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await ctx.engine.advance(run.id);
  assert.equal((await ctx.engine.getRun(run.id)).state, 'creating_change');
  assert.equal(ctx.itsm.state.changes.length, 1);
  await ctx.engine.cancel({ runId: run.id, actor: 'pat' });
  await ctx.engine.advance(run.id);
  const r = await ctx.engine.getRun(run.id);
  assert.equal(r.state, 'cancelled');
  assert.equal(ctx.itsm.state.changes[0].status, 'cancelled');
  assert.equal(r.change_number, ctx.itsm.state.changes[0].number);
});

test('a message the chat system refuses for good is set aside and the rest still go out', async () => {
  const ctx = await setup();
  await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await ctx.engine.advance(1);
  let first = true;
  ctx.notifier.send = async (msg) => {
    if (first) { first = false; throw Object.assign(new Error('HTTP 400'), { permanent: true }); }
    ctx.notifier.sent.push(msg);
  };
  await ctx.engine.deliver();
  const rows = (await ctx.db.query('SELECT status FROM outbox ORDER BY id')).rows.map((x) => x.status);
  assert.deepEqual(rows, ['failed', 'sent']);
  const { events } = await ctx.engine.status('1');
  assert.ok(events.some((e) => /could not be delivered and was set aside/.test(e.message)));
});

test('a message that keeps failing is set aside after ten attempts', async () => {
  const ctx = await setup();
  await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  ctx.notifier.failTimes(10);
  for (let i = 0; i < 10; i += 1) { await ctx.engine.deliver(); ctx.advanceHours(1); }
  const rows = (await ctx.db.query('SELECT status, attempts FROM outbox ORDER BY id')).rows;
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].attempts, 10);
});

test('a lookup error that retrying cannot fix refuses the request instead of retrying for ever', async () => {
  const ctx = await setup();
  ctx.hv.state.failNext.findVm = Object.assign(new Error('refusing to look up an unusual VM name: "APP 01 (old)"'), { refuse: true });
  const run = await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await ctx.engine.advance(run.id);
  const r = await ctx.engine.getRun(run.id);
  assert.equal(r.state, 'refused');
  assert.match(r.outcome, /unusual VM name/);
  await ctx.engine.request({ server: 'DECOM-TEST-29', actor: 'pat' }); // the server is free again
});

test('a CI with an empty status gets it back on cancel', async () => {
  const ctx = await setup();
  ctx.itsm.state.cis[0].status = '';
  const { engine, itsm } = ctx;
  const run = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  await engine.advance(run.id);
  itsm.approve((await engine.getRun(run.id)).change_number);
  await engine.advance(run.id);
  assert.equal(itsm.state.cis[0].status, 'in_maintenance');
  await engine.cancel({ runId: run.id, actor: 'pat' });
  await engine.advance(run.id);
  assert.equal(itsm.state.cis[0].status, '');
});

test('runs advance side by side: a slow shutdown in one run does not hold up another', async () => {
  const ctx = await setup();
  const { engine, itsm, hv } = ctx;
  itsm.addCi({ sysId: 'ci31', name: 'DECOM-TEST-31', uuid: 'uuid-31' }, HOST);
  hv.addVm({ name: 'DECOM-TEST-31', uuid: 'uuid-31', host: HOST.ip });
  const a = await engine.request({ server: 'DECOM-TEST-29', actor: 'pat' });
  const b = await engine.request({ server: 'DECOM-TEST-31', actor: 'pat' });
  await engine.tick();
  itsm.approve((await engine.getRun(a.id)).change_number);
  await engine.tick();
  for (const name of TASKS.slice(0, 3)) itsm.closeTaskByName((await engine.getRun(a.id)).change_number, name);
  let release;
  hv.state.shutdownGate = new Promise((r) => { release = r; });
  ctx.advanceHours(0.1);
  await engine.tick({ wait: false }); // run A starts its shutdown and waits on the slow guest
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await engine.getRun(a.id)).state, 'powering_off');
  itsm.approve((await engine.getRun(b.id)).change_number);
  ctx.advanceHours(0.1);
  await engine.tick({ wait: false }); // run B moves on meanwhile
  for (let i = 0; i < 50 && (await engine.getRun(b.id)).state !== 'prechecks'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await engine.getRun(b.id)).state, 'prechecks');
  assert.equal((await engine.getRun(a.id)).state, 'powering_off', 'A is still waiting for its guest');
  release();
  for (let i = 0; i < 50 && (await engine.getRun(a.id)).state !== 'soaking'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await engine.getRun(a.id)).state, 'soaking');
});
