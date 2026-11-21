// Contract test of the vSphere adapter against a real host, on a disposable test VM. Run inside the
// service container (it uses the service's own settings and adapter):
//   podman exec -i decom-app node - <host IP> <DECOM-TEST-n> [--delete] < contract/vsphere.js
// Without --delete it shuts the VM down, checks a second shutdown is a no-op, and powers it back on.
// With --delete it then shuts it down again and deletes it. Only names DECOM-TEST-<number> are accepted.
const config = require('./src/config');
const { createVsphere } = require('./src/adapters/vsphere-govc');

const [hostIp, name, flag] = process.argv.slice(2);
const step = (n, msg) => console.log(`${String(n).padStart(2)}. ${msg}`);
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); };

(async () => {
  if (!/^DECOM-TEST-\d+$/.test(name || '')) throw new Error('Only a DECOM-TEST-<number> VM may be used.');
  const cfg = config.load();
  const vs = createVsphere(cfg);
  const host = { ip: hostIp, name: hostIp };
  const t0 = Date.now();
  const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;

  const vm = await vs.findVm({ host, name });
  check(vm, `${name} not found`);
  step(1, `found by name: ${vm.ref}, ${vm.powerState}, ${vm.size.cpu} vCPU / ${vm.size.memoryMb} MB / ${vm.size.diskGb} GB, tools ${vm.toolsRunning ? 'running' : 'not running'}`);
  const byUuid = await vs.findVm({ host, name: 'unused', uuid: vm.uuid });
  check(byUuid && byUuid.ref === vm.ref, 'lookup by BIOS UUID');
  const byInst = await vs.findVm({ host, name: 'unused', uuid: vm.instanceUuid });
  check(byInst && byInst.ref === vm.ref, 'lookup by instance UUID');
  step(2, 'found by BIOS UUID and by instance UUID: same VM');

  const how = await vs.shutdown(vm, { host, timeoutSeconds: 60 });
  const off = await vs.findVm({ host, name });
  check(off.powerState === 'poweredOff', `still ${off.powerState} after shutdown`);
  step(3, `shutdown: ${how}, verified poweredOff (${at()})`);

  const again = await vs.shutdown(vm, { host, timeoutSeconds: 60 });
  check(again === 'already_off', `second shutdown returned ${again}`);
  step(4, 'second shutdown: already_off, nothing sent to the host');

  await vs.powerOn(vm, { host });
  const on = await vs.findVm({ host, name });
  check(on.powerState === 'poweredOn', `power-on left it ${on.powerState}`);
  step(5, `power on: verified poweredOn (${at()})`);

  if (flag !== '--delete') { console.log('Done (no delete asked for).'); return; }

  const how2 = await vs.shutdown(on, { host, timeoutSeconds: 60 });
  step(6, `shutdown before delete: ${how2} (${at()})`);
  const size = (await vs.findVm({ host, name })).size;
  await vs.destroy(on, { host });
  const gone = await vs.findVm({ host, name });
  check(gone === null, 'VM still found after delete');
  const goneByUuid = await vs.findVm({ host, name, uuid: vm.uuid });
  check(goneByUuid === null, 'VM still found by UUID after delete');
  step(7, `deleted and verified gone by name and UUID; reclaimed ${size.cpu} vCPU / ${size.memoryMb} MB / ${size.diskGb} GB (${at()})`);
  console.log('All steps passed.');
})().catch((e) => { console.error(e.message); process.exit(1); });
