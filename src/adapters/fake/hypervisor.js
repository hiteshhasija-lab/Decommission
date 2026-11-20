// In-memory vSphere for tests. `loseAnswer` makes the next call do its work and then throw, the way a
// govc timeout looks when the host finished the job anyway.
function fakeHypervisor() {
  const s = { vms: [], calls: [], failNext: {}, loseAnswer: {} };
  const call = (name, vm) => {
    s.calls.push({ name, vm: vm && vm.name });
    if (s.failNext[name]) { const e = s.failNext[name]; delete s.failNext[name]; throw e; }
  };
  const lose = (name) => { if (s.loseAnswer[name]) { delete s.loseAnswer[name]; throw new Error(`timed out waiting for ${name}`); } };
  const find = (vm) => s.vms.find((v) => v.ref === vm.ref);
  return {
    state: s,
    addVm(vm) {
      const rec = { ref: `vm-${s.vms.length + 1}`, powerState: 'poweredOn', size: { cpu: 1, memoryMb: 512, diskGb: 1 }, ...vm };
      s.vms.push(rec);
      return rec;
    },
    async findVm({ host, name, uuid }) {
      call('findVm');
      let hits = uuid ? s.vms.filter((v) => v.uuid === uuid) : [];
      if (!hits.length) hits = s.vms.filter((v) => v.name.toLowerCase() === String(name).toLowerCase() && (!host || !v.host || v.host === host.ip));
      if (hits.length > 1) throw new Error(`more than one VM matches ${name}`);
      return hits[0] ? { ...hits[0] } : null;
    },
    async shutdown(vm) {
      call('shutdown', vm);
      const v = find(vm);
      if (v.powerState === 'poweredOff') return 'already_off';
      v.powerState = 'poweredOff';
      lose('shutdown');
      return 'graceful';
    },
    async powerOn(vm) { call('powerOn', vm); find(vm).powerState = 'poweredOn'; lose('powerOn'); },
    async destroy(vm) {
      call('destroy', vm);
      s.vms = s.vms.filter((v) => v.ref !== vm.ref);
      lose('destroy');
    },
  };
}

module.exports = { fakeHypervisor };
