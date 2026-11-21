// In-memory ServiceNow for tests. Records every write so tests can assert on them, and can be told to
// fail a call, or to make the change and then lose the answer, to exercise the guards.
function fakeItsm() {
  const s = {
    cis: [], hosts: {}, incidents: [], changes: [], tasks: [], notes: [], calls: [],
    failNext: {}, // method -> Error (thrown once)
    seq: 1,
  };
  const call = (name, args) => {
    s.calls.push({ name, args });
    if (s.failNext[name]) { const e = s.failNext[name]; delete s.failNext[name]; throw e; }
  };
  const ciByName = (sysId) => s.cis.find((c) => c.sysId === sysId);
  return {
    state: s,
    addCi(ci, host) {
      const rec = { status: 'installed', className: 'cmdb_ci_vmware_instance', size: {}, ...ci };
      s.cis.push(rec);
      if (host) s.hosts[rec.sysId] = host;
      return rec;
    },
    addIncident(ciSysId, number, at = new Date()) { s.incidents.push({ ciSysId, number, at, active: true }); },
    approve(number) { const c = s.changes.find((x) => x.number === number); c.status = 'approved'; },
    reject(number) { const c = s.changes.find((x) => x.number === number); c.status = 'rejected'; },
    cancelExternally(number) { const c = s.changes.find((x) => x.number === number); c.status = 'cancelled'; },
    closeTaskByName(changeNumber, name, outcome = 'done') {
      const c = s.changes.find((x) => x.number === changeNumber);
      const t = s.tasks.find((x) => x.changeSysId === c.sysId && x.name === name);
      t.status = outcome;
    },

    async findCis(query) {
      call('findCis', [query]);
      const q = String(query).toLowerCase();
      return s.cis.filter((c) => c.name.toLowerCase() === q || c.ip === query).map((c) => ({ ...c }));
    },
    async findHost(ci) { call('findHost', [ci.sysId]); return s.hosts[ci.sysId] || null; },
    async openWork(ci, { exceptChangeSysId } = {}) {
      call('openWork', [ci.sysId]);
      return {
        incidents: s.incidents.filter((i) => i.ciSysId === ci.sysId && i.active).map((i) => ({ number: i.number })),
        changes: s.changes.filter((c) => c.ciSysId === ci.sysId && c.sysId !== exceptChangeSysId && ['pending', 'approved'].includes(c.status)).map((c) => ({ number: c.number })),
      };
    },
    async createChange({ correlationId, ci, requester, taskNames }) {
      const existing = s.changes.find((c) => c.correlationId === correlationId);
      if (existing) return { sysId: existing.sysId, number: existing.number, approvalRequested: true };
      call('createChange', [correlationId]);
      const n = s.seq++;
      const change = { sysId: `chg${n}`, number: `CHG00${String(n).padStart(5, '0')}`, correlationId, ciSysId: ci.sysId, requester, status: 'pending', state: 'assess' };
      s.changes.push(change);
      taskNames.forEach((name, i) => s.tasks.push({ sysId: `${change.sysId}-t${i + 1}`, number: `CTASK00${n}${i + 1}`, changeSysId: change.sysId, name, status: 'open' }));
      if (s.loseCreateAnswer) { s.loseCreateAnswer = false; throw new Error('socket hang up'); }
      return { sysId: change.sysId, number: change.number, approvalRequested: true };
    },
    async findChange(correlationId) {
      call('findChange', [correlationId]);
      const c = s.changes.find((x) => x.correlationId === correlationId);
      return c ? { sysId: c.sysId, number: c.number } : null;
    },
    async getChange(sysId) {
      call('getChange', [sysId]);
      const c = s.changes.find((x) => x.sysId === sysId);
      return { number: c.number, status: c.status, state: c.state };
    },
    async listTasks(changeSysId) {
      call('listTasks', [changeSysId]);
      return s.tasks.filter((t) => t.changeSysId === changeSysId).map((t) => ({ ...t }));
    },
    async closeTask(taskSysId, outcome, note) {
      call('closeTask', [taskSysId, outcome, note]);
      const t = s.tasks.find((x) => x.sysId === taskSysId);
      t.status = outcome; t.note = note;
    },
    async setChangeState(sysId, state, note) {
      call('setChangeState', [sysId, state, note]);
      const c = s.changes.find((x) => x.sysId === sysId);
      c.state = state;
      if (state === 'cancelled') c.status = 'cancelled';
      if (state === 'closed') c.status = 'closed';
    },
    async addWorkNote(sysId, text) { call('addWorkNote', [sysId]); s.notes.push({ sysId, text }); },
    async getCiStatus(ci) { call('getCiStatus', [ci.sysId]); return ciByName(ci.sysId).status; },
    async setCiStatus(ci, status) { call('setCiStatus', [ci.sysId, status]); ciByName(ci.sysId).status = status; },
    async incidentsSince(ci, since) {
      call('incidentsSince', [ci.sysId]);
      return s.incidents.filter((i) => i.ciSysId === ci.sysId && i.at >= since).map((i) => ({ number: i.number }));
    },
    changeLink: (change) => `https://example.service-now.com/change_request.do?sys_id=${change.sysId}`,
  };
}

module.exports = { fakeItsm };
