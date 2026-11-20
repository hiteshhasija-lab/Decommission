// ServiceNow through its REST APIs: the Table API for the CMDB, incidents, change tasks and work notes,
// and the Change Management REST API (sn_chg_rest) to create the change so the normal change model is
// respected. Basic authentication for the integration user (OAuth to follow for production).
//
// Dates: ServiceNow reads and writes date-times in the integration user's time zone, so that user's
// time zone must be GMT/UTC (set on its sys_user record); everything here is UTC.

const INSTALL_STATUS = { 1: 'installed', 2: 'on_order', 3: 'in_maintenance', 4: 'pending_install', 5: 'pending_repair', 6: 'in_stock', 7: 'retired', 8: 'stolen', 100: 'absent' };
const INSTALL_CODE = Object.fromEntries(Object.entries(INSTALL_STATUS).map(([k, v]) => [v, k]));
// change_request.state for the normal change model.
const CHANGE_STATE = { new: '-5', assess: '-4', authorize: '-3', scheduled: '-2', implement: '-1', review: '0', closed: '3', cancelled: '4' };
// change_task.state
const TASK_STATE = { pending: '-5', open: '1', in_progress: '2', closed: '3', cancelled: '4' };

class ServiceNowError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const utc = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const q = (s) => String(s).replace(/\^/g, '');

function createServiceNow(cfg, { fetchImpl = fetch } = {}) {
  const sn = cfg.servicenow;
  const base = /^https?:\/\//.test(sn.instance) ? sn.instance : `https://${sn.instance}`;
  const auth = `Basic ${Buffer.from(`${sn.user}:${sn.password}`).toString('base64')}`;

  async function api(method, path, { query, body } = {}) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(sn.timeoutMs),
      });
    } catch (e) {
      throw new ServiceNowError(`ServiceNow did not answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    const type = res.headers.get('content-type') || '';
    // A hibernating developer instance answers with a web page, not JSON.
    if (!type.includes('json')) throw new ServiceNowError(`ServiceNow is unavailable (HTTP ${res.status}, not JSON; a developer instance may be hibernating)`, res.status);
    const data = await res.json();
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message + (data.error.detail ? `: ${data.error.detail}` : ''))) || `HTTP ${res.status}`;
      throw new ServiceNowError(`ServiceNow ${method} ${url.pathname}: ${msg}`, res.status);
    }
    return data.result;
  }

  const table = (name, query) => api('GET', `/api/now/table/${name}`, { query: { sysparm_exclude_reference_link: 'true', ...query } });
  const patch = (name, sysId, body) => api('PATCH', `/api/now/table/${name}/${sysId}`, { body });

  const CI_FIELDS = 'sys_id,name,ip_address,vm_instance_uuid,object_id,install_status,sys_class_name,cpus,memory,disks_size';

  function toCi(r) {
    return {
      sysId: r.sys_id,
      name: r.name,
      ip: r.ip_address || null,
      uuid: r.vm_instance_uuid || null,
      status: INSTALL_STATUS[r.install_status] || String(r.install_status || ''),
      className: r.sys_class_name,
      size: { cpu: Number(r.cpus) || null, memoryMb: Number(r.memory) || null, diskGb: Number(r.disks_size) || null },
    };
  }

  async function findCis(query) {
    const rows = await table(sn.ciClass, { sysparm_query: `name=${q(query)}^ORip_address=${q(query)}`, sysparm_fields: CI_FIELDS, sysparm_limit: '10' });
    return rows.map(toCi);
  }

  // The ESX host the VM runs on: a cmdb_rel_ci row between the VM and an ESX server CI, in either
  // direction and of any type (Discovery uses "Registered on::Has registered"; hand-made records often
  // use "Virtualized by::Virtualizes" or "Runs on::Runs").
  async function findHost(ci) {
    const rels = await table('cmdb_rel_ci', {
      sysparm_query: `parent=${ci.sysId}^child.sys_class_name=${sn.hostClass}^NQchild=${ci.sysId}^parent.sys_class_name=${sn.hostClass}`,
      sysparm_fields: 'parent,child', sysparm_limit: '5',
    });
    const ids = [...new Set(rels.map((r) => (val(r.parent) === ci.sysId ? val(r.child) : val(r.parent))))];
    if (ids.length !== 1) return null;
    const hosts = await table(sn.hostClass, { sysparm_query: `sys_id=${ids[0]}`, sysparm_fields: 'sys_id,name,ip_address' });
    return hosts[0] ? { sysId: hosts[0].sys_id, name: hosts[0].name, ip: hosts[0].ip_address || null } : null;
  }

  async function openWork(ci, { exceptChangeSysId } = {}) {
    const incidents = await table('incident', { sysparm_query: `cmdb_ci=${ci.sysId}^active=true`, sysparm_fields: 'number', sysparm_limit: '20' });
    const changes = await table('change_request', {
      sysparm_query: `cmdb_ci=${ci.sysId}^active=true${exceptChangeSysId ? `^sys_id!=${exceptChangeSysId}` : ''}`, sysparm_fields: 'number', sysparm_limit: '20',
    });
    return { incidents, changes };
  }

  let groupSysId; // looked up once
  async function assignmentGroup() {
    if (!sn.assignmentGroup) return undefined;
    if (groupSysId === undefined) {
      const rows = await table('sys_user_group', { sysparm_query: `name=${q(sn.assignmentGroup)}`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
      groupSysId = rows[0] ? rows[0].sys_id : null;
    }
    return groupSysId || undefined;
  }

  async function userSysId(name) {
    const rows = await table('sys_user', { sysparm_query: `user_name=${q(name)}^ORemail=${q(name)}`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
    return rows[0] ? rows[0].sys_id : undefined;
  }

  async function createChange({ correlationId, ci, requester, taskNames, start, end }) {
    const existing = await table('change_request', { sysparm_query: `correlation_id=${q(correlationId)}`, sysparm_fields: 'sys_id,number,state', sysparm_limit: '1' });
    let sysId; let number;
    if (existing[0]) {
      ({ sys_id: sysId, number } = existing[0]);
    } else {
      const body = {
        short_description: `Decommission ${ci.name}`,
        description: `Decommission of VM ${ci.name} (${ci.ip || 'no IP recorded'}) on ${ci.host.name}, requested by ${requester} through the decommission orchestrator.`,
        cmdb_ci: ci.sysId,
        correlation_id: correlationId,
        correlation_display: 'Decommission orchestrator',
        start_date: utc(start),
        end_date: utc(end),
        justification: `Server decommission requested by ${requester}.`,
        implementation_plan: 'Pre-checks (backup, monitoring, DNS/firewall); graceful shutdown; soak period; confirmed delete; retire CI.',
        backout_plan: 'Before the delete: power the VM back on and restore the CI status. The orchestrator does this on cancel.',
        test_plan: 'VM state verified in vSphere after each step.',
        assignment_group: await assignmentGroup(),
        requested_by: await userSysId(requester).catch(() => undefined),
      };
      let created;
      try {
        created = await api('POST', '/api/sn_chg_rest/change/normal', { body });
      } catch (e) {
        if (e.status !== 404) throw e; // the Change Management REST API is not active: use the table
        created = await api('POST', '/api/now/table/change_request', { body: { ...body, type: 'normal' } });
      }
      sysId = val(created.sys_id); number = val(created.number);
    }
    // Tasks, once each (a re-run finds the ones already there).
    const have = new Set((await listTasks(sysId)).map((t) => t.name));
    let order = 100;
    for (const name of taskNames) {
      order += 100;
      if (have.has(name)) continue;
      await api('POST', '/api/now/table/change_task', { body: { change_request: sysId, short_description: name, order: String(order), cmdb_ci: ci.sysId } });
    }
    // Ask for approval: New -> Assess starts the approval engine. The change model may refuse (for example
    // a mandatory field this instance requires); then people move it on in ServiceNow, and polling follows.
    let approvalRequested = true; let note;
    const now = await table('change_request', { sysparm_query: `sys_id=${sysId}`, sysparm_fields: 'state,approval' });
    if (now[0] && now[0].state === CHANGE_STATE.new) {
      try {
        await patch('change_request', sysId, { state: CHANGE_STATE.assess });
        const after = await table('change_request', { sysparm_query: `sys_id=${sysId}`, sysparm_fields: 'state' });
        if (after[0] && after[0].state === CHANGE_STATE.new) throw new Error('the change stayed in New');
      } catch (e) {
        approvalRequested = false;
        note = `Could not move ${number} to Assess (${e.message}); move it to Assess in ServiceNow to request approval.`;
      }
    }
    return { sysId, number, approvalRequested, note };
  }

  async function getChange(sysId) {
    const rows = await table('change_request', { sysparm_query: `sys_id=${sysId}`, sysparm_fields: 'number,state,approval,active' });
    const c = rows[0];
    if (!c) return { number: null, status: 'cancelled' };
    let status = 'pending';
    if (c.state === CHANGE_STATE.cancelled) status = 'cancelled';
    else if (c.state === CHANGE_STATE.closed) status = 'closed';
    else if (c.approval === 'rejected') status = 'rejected';
    else if (c.approval === 'approved' && [CHANGE_STATE.scheduled, CHANGE_STATE.implement, CHANGE_STATE.review].includes(c.state)) status = 'approved';
    return { number: c.number, status, state: c.state, approval: c.approval };
  }

  async function listTasks(changeSysId) {
    const rows = await table('change_task', { sysparm_query: `change_request=${changeSysId}^ORDERBYorder`, sysparm_fields: 'sys_id,number,short_description,state', sysparm_limit: '50' });
    return rows.map((t) => ({
      sysId: t.sys_id, number: t.number, name: t.short_description,
      status: t.state === TASK_STATE.closed ? 'done' : t.state === TASK_STATE.cancelled ? 'skipped' : 'open',
    }));
  }

  async function closeTask(taskSysId, outcome, note) {
    await patch('change_task', taskSysId, outcome === 'done'
      ? { state: TASK_STATE.closed, close_code: 'successful', close_notes: note }
      : { state: TASK_STATE.cancelled, close_notes: note });
  }

  // Implement, then Review and Closed (the model wants each step in turn); Cancelled from anywhere.
  async function setChangeState(sysId, state, note) {
    const current = (await table('change_request', { sysparm_query: `sys_id=${sysId}`, sysparm_fields: 'state' }))[0];
    if (!current) throw new ServiceNowError('The change no longer exists.');
    if (state === 'implement') {
      if (current.state !== CHANGE_STATE.implement) await patch('change_request', sysId, { state: CHANGE_STATE.implement, work_notes: note });
    } else if (state === 'review' || state === 'closed') {
      if (current.state === CHANGE_STATE.scheduled) await patch('change_request', sysId, { state: CHANGE_STATE.implement });
      if (current.state !== CHANGE_STATE.review && current.state !== CHANGE_STATE.closed) await patch('change_request', sysId, { state: CHANGE_STATE.review });
      if (state === 'closed' && current.state !== CHANGE_STATE.closed) {
        await patch('change_request', sysId, { state: CHANGE_STATE.closed, close_code: 'successful', close_notes: note });
      }
    } else if (state === 'cancelled') {
      if (current.state !== CHANGE_STATE.cancelled) await patch('change_request', sysId, { state: CHANGE_STATE.cancelled, work_notes: note });
    } else {
      throw new Error(`Unknown change state ${state}`);
    }
  }

  const addWorkNote = (sysId, text) => patch('change_request', sysId, { work_notes: text }).then(() => undefined);

  async function getCiStatus(ci) {
    const rows = await table('cmdb_ci', { sysparm_query: `sys_id=${ci.sysId}`, sysparm_fields: 'install_status' });
    return rows[0] ? INSTALL_STATUS[rows[0].install_status] || String(rows[0].install_status) : null;
  }

  async function setCiStatus(ci, status) {
    const code = INSTALL_CODE[status] || status;
    const body = { install_status: code };
    if (status === 'retired') body.operational_status = '6'; // Retired
    await patch(ci.className || 'cmdb_ci', ci.sysId, body);
  }

  async function incidentsSince(ci, since) {
    return table('incident', { sysparm_query: `cmdb_ci=${ci.sysId}^sys_created_on>=${utc(since)}`, sysparm_fields: 'number', sysparm_limit: '20' });
  }

  const changeLink = (change) => `${base}/change_request.do?sys_id=${change.sysId}`;

  // Read-only connection check for `decom check`.
  async function check() {
    const me = await table('sys_user', { sysparm_query: `user_name=${q(sn.user)}`, sysparm_fields: 'user_name,time_zone', sysparm_limit: '1' });
    const cis = await table(sn.ciClass, { sysparm_fields: 'sys_id', sysparm_limit: '1' });
    const chg = await table('change_request', { sysparm_fields: 'sys_id', sysparm_limit: '1' });
    return { user: me[0] ? me[0].user_name : sn.user, timeZone: me[0] ? me[0].time_zone || '(system default)' : 'unknown', canReadCis: Array.isArray(cis), canReadChanges: Array.isArray(chg) };
  }

  return { findCis, findHost, openWork, createChange, getChange, listTasks, closeTask, setChangeState, addWorkNote, getCiStatus, setCiStatus, incidentsSince, changeLink, check };
}

module.exports = { createServiceNow, ServiceNowError, INSTALL_STATUS, CHANGE_STATE, TASK_STATE };
