const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../src/config');
const { createServiceNow } = require('../src/adapters/servicenow');
const { createVsphere } = require('../src/adapters/vsphere-govc');

const cfg = load({ SN_INSTANCE: 'dev12345.service-now.com', SN_USER: 'decom.integration', SN_PASSWORD: 'x', VSPHERE_USER: 'u', VSPHERE_PASSWORD: 'p', VSPHERE_INSECURE: '1' });

// A fake ServiceNow answering by method + path + query.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const u = new URL(url);
    const key = `${opts.method} ${u.pathname}`;
    calls.push({ key, query: u.searchParams.get('sysparm_query'), body: opts.body ? JSON.parse(opts.body) : undefined });
    const handler = routes[key];
    const [status, body, type = 'application/json'] = handler ? handler(u, opts) : [404, { error: { message: 'no route' } }];
    return { ok: status < 400, status, headers: { get: () => type }, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('ServiceNow: change status from state + approval', async () => {
  const cases = [
    [{ state: '-4', approval: 'requested' }, 'pending'],
    [{ state: '-3', approval: 'requested' }, 'pending'],
    [{ state: '-2', approval: 'approved' }, 'approved'],
    [{ state: '-1', approval: 'approved' }, 'approved'],
    [{ state: '-4', approval: 'rejected' }, 'rejected'],
    [{ state: '4', approval: 'requested' }, 'cancelled'],
    [{ state: '3', approval: 'approved' }, 'closed'],
  ];
  for (const [row, want] of cases) {
    const sn = createServiceNow(cfg, { fetchImpl: fakeFetch({ 'GET /api/now/table/change_request': () => [200, { result: [{ number: 'CHG1', ...row }] }] }) });
    assert.equal((await sn.getChange('abc')).status, want, JSON.stringify(row));
  }
});

test('ServiceNow: a hibernating instance (HTML page) is "unavailable", not a crash', async () => {
  const sn = createServiceNow(cfg, { fetchImpl: fakeFetch({ 'GET /api/now/table/change_request': () => [200, '<html>', 'text/html'] }) });
  await assert.rejects(sn.getChange('abc'), /unavailable.*hibernating/);
});

test('ServiceNow: createChange reuses the change for a correlation ID and adds only missing tasks', async () => {
  const f = fakeFetch({
    'GET /api/now/table/change_request': (u) => [200, { result: u.searchParams.get('sysparm_query').startsWith('correlation_id') ? [{ sys_id: 's1', number: 'CHG0030001' }] : [{ state: '-4' }] }],
    'GET /api/now/table/change_task': () => [200, { result: [{ sys_id: 't1', number: 'CTASK1', short_description: 'Verify backup completed', state: '1' }] }],
    'POST /api/now/table/change_task': () => [201, { result: {} }],
  });
  const sn = createServiceNow(cfg, { fetchImpl: f });
  const c = await sn.createChange({ correlationId: 'decom-orchestrator-run-1', ci: { sysId: 'ci', name: 'X', host: { name: 'h' } }, requester: 'pat', taskNames: ['Verify backup completed', 'Remove from monitoring'], start: new Date(), end: new Date() });
  assert.deepEqual([c.sysId, c.number, c.approvalRequested], ['s1', 'CHG0030001', true]);
  assert.equal(f.calls.filter((x) => x.key === 'POST /api/sn_chg_rest/change/normal').length, 0);
  const posted = f.calls.filter((x) => x.key === 'POST /api/now/table/change_task').map((x) => x.body.short_description);
  assert.deepEqual(posted, ['Remove from monitoring']);
});

test('ServiceNow: new change through the Change API, then moved to Assess', async () => {
  let state = '-5';
  const f = fakeFetch({
    'GET /api/now/table/change_request': (u) => [200, { result: u.searchParams.get('sysparm_query').startsWith('correlation_id') ? [] : [{ state }] }],
    'POST /api/sn_chg_rest/change/normal': () => [200, { result: { sys_id: { value: 's9', display_value: 's9' }, number: { value: 'CHG0030009' } } }],
    'GET /api/now/table/change_task': () => [200, { result: [] }],
    'POST /api/now/table/change_task': () => [201, { result: {} }],
    'GET /api/now/table/sys_user': () => [200, { result: [] }],
    'PATCH /api/now/table/change_request/s9': (_u, o) => { state = JSON.parse(o.body).state; return [200, { result: {} }]; },
  });
  const sn = createServiceNow(cfg, { fetchImpl: f });
  const c = await sn.createChange({ correlationId: 'k', ci: { sysId: 'ci', name: 'X', host: { name: 'h' } }, requester: 'pat', taskNames: ['A', 'B'], start: new Date('2026-11-20T10:00:00Z'), end: new Date('2026-11-22T10:00:00Z') });
  assert.equal(c.number, 'CHG0030009');
  assert.equal(c.approvalRequested, true);
  assert.equal(state, '-4');
  const body = f.calls.find((x) => x.key === 'POST /api/sn_chg_rest/change/normal').body;
  assert.equal(body.start_date, '2026-11-20 10:00:00');
  assert.equal(body.correlation_id, 'k');
});

test('ServiceNow: host found through a relationship in either direction', async () => {
  const f = fakeFetch({
    'GET /api/now/table/cmdb_rel_ci': () => [200, { result: [{ parent: 'esx1', child: 'ci1' }] }],
    'GET /api/now/table/cmdb_ci_esx_server': () => [200, { result: [{ sys_id: 'esx1', name: 'ESXi 7', ip_address: '10.0.0.65' }] }],
  });
  const host = await createServiceNow(cfg, { fetchImpl: f }).findHost({ sysId: 'ci1' });
  assert.deepEqual(host, { sysId: 'esx1', name: 'ESXi 7', ip: '10.0.0.65' });
});

// govc answers by subcommand.
function fakeExec(answers) {
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ args, env: opts.env });
    const a = answers[args[0]];
    const out = typeof a === 'function' ? a(args) : a;
    if (out instanceof Error) cb(Object.assign(out, { stderr: out.message }), '', out.message);
    else cb(null, out, '');
  };
  exec.calls = calls;
  return exec;
}

const VMINFO = JSON.stringify({ virtualMachines: [{
  config: { name: 'DECOM-TEST-29', uuid: '564d-aaaa', instanceUuid: '5200-bbbb', hardware: { numCPU: 1, memoryMB: 512, device: [{ capacityInBytes: 1073741824 }, { label: 'nic' }] } },
  runtime: { powerState: 'poweredOn' }, guest: { ipAddress: '', toolsRunningStatus: 'guestToolsNotRunning' },
}] });

test('vSphere: finds a VM by name, reads its size, and uses the CMDB host as the endpoint', async () => {
  const exec = fakeExec({ find: '/ha-datacenter/vm/DECOM-TEST-29\n', 'vm.info': VMINFO });
  const vs = createVsphere(cfg, { exec });
  const vm = await vs.findVm({ host: { ip: '10.0.0.65' }, name: 'DECOM-TEST-29' });
  assert.equal(vm.ref, '/ha-datacenter/vm/DECOM-TEST-29');
  assert.deepEqual(vm.size, { cpu: 1, memoryMb: 512, diskGb: 1 });
  assert.equal(vm.powerState, 'poweredOn');
  assert.equal(exec.calls[0].env.GOVC_URL, 'https://10.0.0.65/sdk');
  assert.equal(exec.calls[0].env.GOVC_INSECURE, '1');
});

test('vSphere: two VMs with the same name is an error; odd names never reach govc', async () => {
  const vs = createVsphere(cfg, { exec: fakeExec({ find: '/dc/vm/A/X-1\n/dc/vm/B/X-1\n' }) });
  await assert.rejects(vs.findVm({ host: { ip: '10.0.0.65' }, name: 'X-1' }), /more than one VM/);
  const exec = fakeExec({});
  await assert.rejects(createVsphere(cfg, { exec }).findVm({ host: { ip: '10.0.0.65' }, name: '*' }), /unusual VM name/);
  assert.equal(exec.calls.length, 0);
});

test('vSphere: hosts outside VSPHERE_ALLOWED_HOSTS are refused', async () => {
  const c = load({ VSPHERE_USER: 'u', VSPHERE_PASSWORD: 'p', VSPHERE_ALLOWED_HOSTS: '10.0.0.65' });
  await assert.rejects(createVsphere(c, { exec: fakeExec({}) }).findVm({ host: { ip: '10.0.0.66' }, name: 'X' }), /not in VSPHERE_ALLOWED_HOSTS/);
});

test('vSphere: the connection check proves the login with a VM count', async () => {
  const exec = fakeExec({ about: 'FullName:     VMware ESXi 7.0.2 build-17867351\nName: VMware ESXi\n', find: '/dc/vm/A\n/dc/vm/B\n' });
  assert.equal(await createVsphere(cfg, { exec }).about({ ip: '10.0.0.65' }), 'VMware ESXi 7.0.2 build-17867351; logged in, 2 VMs visible');
  const bad = fakeExec({ about: 'FullName: x\n', find: new Error('ServerFaultCode: Cannot complete login due to an incorrect user name or password.') });
  await assert.rejects(createVsphere(cfg, { exec: bad }).about({ ip: '10.0.0.65' }), /incorrect user name or password/);
});
