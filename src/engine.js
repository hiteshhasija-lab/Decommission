// The decommission workflow: one state machine per request, written to the database before every
// external call so a crash or restart never leaves it unsure where it was. The steps and guards are
// the ones proven in the lab build (change-gated execution, pre-check gate, one guarded power-off,
// soak period, confirmation before the delete, no blind retries of irreversible steps, resume after a
// restart) plus the drift check between the CMDB and vSphere.
//
// It talks to the outside only through three ports (src/ports.js): itsm (ServiceNow), hypervisor
// (vSphere) and notifier (Teams). ServiceNow stays the system of record; this keeps workflow state only.

const TASKS = [
  'Verify backup completed',
  'Remove from monitoring',
  'DNS / firewall cleanup',
  'Power off — soak period',
  'Destroy VM & release resources',
  'Retire CI in CMDB',
  'Update tracker & reclaim licenses',
];
const MANUAL_TASKS = TASKS.slice(0, 3);
const [, , , POWER_TASK, DESTROY_TASK, RETIRE_TASK, TRACKER_TASK] = TASKS;

const FINAL = ['completed', 'rejected', 'cancelled', 'refused'];
// Waiting states: nothing to do until ServiceNow, a timer or a person moves them on.
// In-flight states: a step with external side effects is under way; on a restart it resumes.
// A failure in a step that changes a VM is never retried automatically: the run is marked for
// attention and waits for `decom retry`.
const VM_CHANGING = ['powering_off', 'destroying', 'cancelling'];
const CANCELLABLE = ['validating', 'creating_change', 'awaiting_approval', 'prechecks', 'soaking', 'awaiting_destroy_confirm', 'on_hold'];
const STATE_LABELS = {
  validating: 'Checking the CMDB and vSphere',
  creating_change: 'Creating the change',
  awaiting_approval: 'Waiting for change approval in ServiceNow',
  prechecks: 'Waiting for the pre-checks',
  powering_off: 'Shutting the VM down',
  soaking: 'Soak period (VM powered off)',
  awaiting_destroy_confirm: 'Waiting for a person to confirm the delete',
  destroying: 'Deleting the VM',
  retiring: 'Retiring the CI and closing the change',
  on_hold: 'On hold: an incident was raised during the soak period',
  cancelling: 'Cancelling',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

class DecomError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sentence = (m) => `${String(m).trim().replace(/[.\s]+$/, '')}.`;
const errText = (e) => sentence((e && e.message) || String(e));

function formatDuration(hours) {
  const minutes = hours * 60;
  if (minutes < 60) { const m = Math.round(minutes); return `${m} minute${m === 1 ? '' : 's'}`; }
  if (hours <= 48) { const h = Math.round(hours * 10) / 10; return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.round((hours / 24) * 10) / 10;
  return `${d} day${d === 1 ? '' : 's'}`;
}

function sizeText(size) {
  if (!size) return '—';
  const parts = [];
  if (size.cpu) parts.push(`${size.cpu} vCPU`);
  if (size.memoryMb) parts.push(size.memoryMb >= 1024 ? `${Math.round((size.memoryMb / 1024) * 10) / 10} GB RAM` : `${size.memoryMb} MB RAM`);
  if (size.diskGb) parts.push(`${Math.round(size.diskGb * 10) / 10} GB storage`);
  return parts.length ? parts.join(' · ') : '—';
}

// Identity check between the CMDB record and the VM vSphere returned. Any mismatch stops the run.
function driftProblems(ci, vm) {
  const out = [];
  if (!vm) return ['the VM was not found in vSphere'];
  if (String(ci.name).toLowerCase() !== String(vm.name).toLowerCase()) out.push(`name: CMDB says ${ci.name}, vSphere says ${vm.name}`);
  if (ci.uuid) {
    const ids = [vm.uuid, vm.instanceUuid].filter(Boolean).map((u) => u.toLowerCase());
    if (!ids.includes(String(ci.uuid).toLowerCase())) out.push(`UUID: CMDB says ${ci.uuid}, vSphere says ${vm.uuid || 'none'}`);
  }
  if (ci.ip && vm.ip && ci.ip !== vm.ip) out.push(`IP address: CMDB says ${ci.ip}, vSphere says ${vm.ip}`);
  return out;
}

function createEngine({ db, itsm, hypervisor, notifier, config, now = () => new Date(), log = console, autoKick = true }) {
  const busy = new Set(); // runs being advanced by this process

  // ---------- records ----------
  async function getRun(id) {
    const { rows } = await db.query('SELECT * FROM decom_runs WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async function event(runId, actor, kind, message, data) {
    await db.query('INSERT INTO decom_events (run_id, actor, kind, message, data, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [runId, actor || 'orchestrator', kind, message, data === undefined ? null : JSON.stringify(data), now()]);
  }

  // Queue a chat message. The key makes it once-only, however often the step that sends it runs.
  async function notify(runId, key, message, data) {
    await db.query(`INSERT INTO outbox (run_id, key, message, data, created_at, next_try_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)
      ON CONFLICT (key) DO NOTHING`, [runId, `run:${runId}:${key}`, message, data === undefined ? null : JSON.stringify(data), now()]);
  }

  // Compare-and-set on the run's state: only one caller wins a transition, in any number of processes.
  const COLUMNS = new Set(['state', 'ci', 'vm', 'change_sys_id', 'change_number', 'ci_status_before', 'powered_off_at', 'soak_ends_at',
    'destroy_confirmed_by', 'destroy_confirmed_at', 'destroy_issued_at', 'reclaimed', 'attention', 'outcome', 'next_check_at', 'finished_at']);
  async function update(runId, fields, fromState) {
    const sets = []; const params = [runId];
    for (const [k, v] of Object.entries(fields)) {
      if (!COLUMNS.has(k)) throw new Error(`unknown column ${k}`);
      const json = (k === 'ci' || k === 'vm' || k === 'reclaimed') && v !== null;
      params.push(json ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}${json ? '::jsonb' : ''}`);
    }
    params.push(now());
    sets.push(`updated_at = $${params.length}`);
    let where = 'id = $1';
    if (fromState) { params.push(fromState); where += ` AND state = $${params.length}`; }
    const { rows } = await db.query(`UPDATE decom_runs SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params);
    return rows[0] || null;
  }

  async function transition(run, to, fields = {}, message) {
    const updated = await update(run.id, { ...fields, state: to, next_check_at: fields.next_check_at || now(),
      ...(FINAL.includes(to) ? { finished_at: now() } : {}) }, run.state);
    if (!updated) throw new DecomError(409, `Run ${run.id} is no longer ${STATE_LABELS[run.state] || run.state}; another action got there first.`);
    await event(run.id, null, 'state', message || `${STATE_LABELS[run.state] || run.state} → ${STATE_LABELS[to] || to}`, { from: run.state, to });
    return updated;
  }

  // Run an external write once per key; a step that runs again gets the recorded result instead.
  async function once(key, fn) {
    const { rows } = await db.query('SELECT result FROM idempotency_keys WHERE key = $1', [key]);
    if (rows[0]) return rows[0].result;
    const result = (await fn()) ?? null;
    await db.query('INSERT INTO idempotency_keys (key, result, created_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(result), now()]);
    return result;
  }

  const later = (seconds = config.pollSeconds) => new Date(now().getTime() + seconds * 1000);
  const isNeverTouch = (name) => config.neverTouch.includes(String(name || '').toLowerCase());
  const ciLabel = (run) => (run.ci && run.ci.name) || run.server;
  const changeLabel = (run) => run.change_number || 'the change';
  const link = (run) => (run.change_sys_id && itsm.changeLink ? itsm.changeLink({ sysId: run.change_sys_id, number: run.change_number }) : null);

  async function needsAttention(run, message) {
    await update(run.id, { attention: message });
    await event(run.id, null, 'attention', message);
    await notify(run.id, `attention:${run.state}:${Date.now()}`, `⚠️ ${ciLabel(run)} (${changeLabel(run)}): ${message} It will wait for a person: fix the cause, then run "decom retry ${run.id}", or "decom cancel ${run.id}".`);
    if (run.change_sys_id) await itsm.addWorkNote(run.change_sys_id, `Decommission orchestrator needs attention: ${message}`).catch(() => {});
  }

  async function closeTaskOnce(run, name, note) {
    await once(`run:${run.id}:task:${name}`, async () => {
      const task = (await itsm.listTasks(run.change_sys_id)).find((t) => t.name === name);
      if (task && task.status === 'open') await itsm.closeTask(task.sysId, 'done', note);
      return { closed: !!task };
    });
  }

  async function workNoteOnce(run, key, text) {
    await once(`run:${run.id}:note:${key}`, () => itsm.addWorkNote(run.change_sys_id, text).then(() => true));
  }

  // The change was cancelled or rejected in ServiceNow while the run waited: follow it.
  async function followChange(run, change) {
    if (change.status === 'rejected') {
      await transition(run, 'cancelling', { outcome: `${run.change_number} was rejected in ServiceNow.` });
      return true;
    }
    if (change.status === 'cancelled' || change.status === 'closed') {
      await transition(run, 'cancelling', { outcome: `${run.change_number} was ${change.status} in ServiceNow.` });
      return true;
    }
    return false;
  }

  // ---------- steps ----------
  const steps = {
    async validating(run) {
      const refuse = async (why) => {
        await transition(run, 'refused', { outcome: sentence(why) });
        await notify(run.id, 'refused', `❌ Cannot decommission ${run.server}: ${sentence(why)}`);
      };
      if (isNeverTouch(run.server)) return refuse(`${run.server} is on the never-touch list`);
      const cis = await itsm.findCis(run.server);
      if (!cis.length) return refuse(`no CMDB record matches "${run.server}"`);
      if (cis.length > 1) return refuse(`more than one CMDB record matches "${run.server}" (${cis.map((c) => c.name).join(', ')}); use the exact name`);
      const ci = cis[0];
      if (isNeverTouch(ci.name)) return refuse(`${ci.name} is on the never-touch list`);
      if (ci.status === 'retired') return refuse(`${ci.name} is already retired in the CMDB`);
      const host = await itsm.findHost(ci);
      if (!host) return refuse(`${ci.name} has no hypervisor host recorded in the CMDB (relationship to an ESX server)`);
      const work = await itsm.openWork(ci, {});
      const open = [...work.incidents, ...work.changes].map((x) => x.number);
      if (open.length) return refuse(`${ci.name} has open records: ${open.join(', ')}`);
      let vm;
      try {
        vm = await hypervisor.findVm({ host, name: ci.name, uuid: ci.uuid });
      } catch (e) {
        if (/more than one/i.test(e.message)) return refuse(e.message);
        throw e;
      }
      if (!vm) return refuse(`no VM named ${ci.name} was found on ${host.name}`);
      const drift = driftProblems(ci, vm);
      if (drift.length) return refuse(`the CMDB and vSphere disagree (${drift.join('; ')})`);
      await transition(run, 'creating_change', { ci: { ...ci, host }, vm },
        `Validated ${ci.name}: VM found on ${host.name}, ${vm.powerState}, ${sizeText(vm.size)}.`);
      return 'continue';
    },

    async creating_change(run) {
      const start = now();
      const end = new Date(start.getTime() + (config.soakHours + 24) * 3600 * 1000);
      // ServiceNow returns the existing change for this correlation ID, so a crash after the change was
      // created but before it was saved here never makes a second one.
      const change = await itsm.createChange({
        correlationId: `decom-orchestrator-run-${run.id}`,
        ci: run.ci, requester: run.requested_by, taskNames: TASKS, start, end,
      });
      const updated = await transition(run, 'awaiting_approval', { change_sys_id: change.sysId, change_number: change.number },
        `Created ${change.number}${change.approvalRequested ? ' and requested approval' : ''}.`);
      await workNoteOnce(updated, 'created',
        `Created by the decommission orchestrator (run ${run.id}) for ${run.requested_by}. VM ${run.ci.name} on ${run.ci.host.name}` +
        ` (${run.vm.powerState}, ${sizeText(run.vm.size)}). Soak period after power-off: ${formatDuration(config.soakHours)}.` +
        (config.dryRun ? ' DRY RUN: the VM will not be deleted.' : ''));
      const where = link(updated);
      await notify(run.id, 'change-created', `📝 ${change.number} created to decommission ${run.ci.name}. It needs approval in ServiceNow${where ? `: ${where}` : ''}.` +
        (change.approvalRequested ? '' : ` ${change.note || 'Approval could not be requested automatically; move the change to Assess in ServiceNow.'}`),
      { changeNumber: change.number, link: where });
      if (!change.approvalRequested && change.note) await event(run.id, null, 'warning', change.note);
      return 'continue';
    },

    async awaiting_approval(run) {
      const change = await itsm.getChange(run.change_sys_id);
      if (change.status === 'pending') return 'wait';
      if (change.status === 'rejected') {
        await transition(run, 'rejected', { outcome: `${run.change_number} was rejected in ServiceNow.` });
        await notify(run.id, 'rejected', `❌ ${run.change_number} was rejected. ${run.ci.name} stays as it is.`);
        return 'stop';
      }
      if (await followChange(run, change)) return 'continue';
      // Approved. Maintenance mode first, keeping the status it had so a cancel can put it back.
      let before = run.ci_status_before;
      if (!before) {
        before = await itsm.getCiStatus(run.ci);
        if (before !== 'in_maintenance') await update(run.id, { ci_status_before: before });
      }
      await itsm.setCiStatus(run.ci, 'in_maintenance');
      await transition(run, 'prechecks', {}, `${run.change_number} approved; CI set to In maintenance.`);
      await notify(run.id, 'approved', `✅ ${run.change_number} approved. ${run.ci.name} is in maintenance mode. Next: the pre-checks ` +
        `(${MANUAL_TASKS.join(', ')}). Close each change task in ServiceNow (Closed = done, Cancelled = skipped), or run "decom precheck ${run.id} <1-3> done|skip".`);
      return 'continue';
    },

    async prechecks(run) {
      const change = await itsm.getChange(run.change_sys_id);
      if (await followChange(run, change)) return 'continue';
      const tasks = await itsm.listTasks(run.change_sys_id);
      const manual = MANUAL_TASKS.map((name) => tasks.find((t) => t.name === name));
      const missing = MANUAL_TASKS.filter((name, i) => !manual[i]);
      if (missing.length) {
        await needsAttention(run, `the change has no task for: ${missing.join(', ')}.`);
        return 'stop';
      }
      for (const t of manual) {
        if (t.status !== 'open') await notify(run.id, `precheck:${t.number}`, `☑️ Pre-check ${t.status === 'done' ? 'completed' : 'skipped'}: ${t.name} (${t.number}).`);
      }
      if (manual.some((t) => t.status === 'open')) return 'wait';
      await transition(run, 'powering_off', {}, 'All pre-checks resolved.');
      return 'continue';
    },

    async powering_off(run) {
      const change = await itsm.getChange(run.change_sys_id);
      if (await followChange(run, change)) return 'continue';
      if (change.status !== 'approved') { await needsAttention(run, `${run.change_number} is not approved (${change.status}), so the VM was not shut down.`); return 'stop'; }
      const tasks = await itsm.listTasks(run.change_sys_id);
      if (MANUAL_TASKS.some((name) => (tasks.find((t) => t.name === name) || {}).status === 'open')) {
        await transition(run, 'prechecks', {}, 'A pre-check was reopened; waiting for it again.');
        return 'continue';
      }
      if (isNeverTouch(run.ci.name)) { await needsAttention(run, `${run.ci.name} is on the never-touch list.`); return 'stop'; }
      const vm = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid });
      const drift = driftProblems(run.ci, vm);
      if (drift.length) { await needsAttention(run, `the VM no longer matches the CMDB record (${drift.join('; ')}), so it was not shut down.`); return 'stop'; }

      await once(`run:${run.id}:change:implement`, () => itsm.setChangeState(run.change_sys_id, 'implement', 'Shutting the VM down.').then(() => true));
      let how;
      if (vm.powerState === 'poweredOff') {
        how = 'already_off';
      } else {
        await event(run.id, null, 'vsphere', `Shutting down ${vm.name} on ${run.ci.host.name}.`);
        try {
          how = await hypervisor.shutdown(vm, { host: run.ci.host, timeoutSeconds: config.shutdownTimeoutSeconds });
        } catch (e) {
          // The answer may be lost although the host did it: look before deciding.
          const after = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid }).catch(() => null);
          if (!after || after.powerState !== 'poweredOff') throw e;
          how = 'confirmed_after_error';
          await event(run.id, null, 'vsphere', `The shutdown call failed (${errText(e)}) but the VM is off, so the step counts as done.`);
        }
      }
      await closeTaskOnce(run, POWER_TASK, `Powered off by the decommission orchestrator (${how.replace(/_/g, ' ')}).`);
      const soakEnds = new Date(now().getTime() + config.soakHours * 3600 * 1000);
      const updated = await transition(run, 'soaking', { powered_off_at: now(), soak_ends_at: soakEnds, next_check_at: later() },
        `${vm.name} is powered off (${how.replace(/_/g, ' ')}). Soak period until ${soakEnds.toISOString()}.`);
      await workNoteOnce(updated, `powered-off:${soakEnds.getTime()}`, `${vm.name} powered off on ${run.ci.host.name}. Soak period of ${formatDuration(config.soakHours)} ends ${soakEnds.toISOString()} (UTC). ` +
        'Any incident raised against this CI in that time powers it back on and stops the decommission.');
      await notify(run.id, `powered-off:${soakEnds.getTime()}`, `🔌 ${vm.name} is powered off. Soak period: ${formatDuration(config.soakHours)} (ends ${soakEnds.toISOString().slice(0, 16).replace('T', ' ')} UTC). ` +
        'An incident against the CI in that time powers it back on.');
      return 'stop';
    },

    async soaking(run) {
      const change = await itsm.getChange(run.change_sys_id);
      if (await followChange(run, change)) return 'continue';
      if (await incidentHold(run)) return 'stop';
      if (now() < new Date(run.soak_ends_at)) {
        await update(run.id, { next_check_at: new Date(Math.min(new Date(run.soak_ends_at).getTime(), later().getTime())) });
        return 'stop';
      }
      await transition(run, 'awaiting_destroy_confirm', { next_check_at: later() }, 'Soak period ended with no incidents.');
      await notify(run.id, `confirm-destroy:${new Date(run.soak_ends_at).getTime()}`, `⏱️ The soak period for ${run.ci.name} (${run.change_number}) ended with no incidents. ` +
        `An authorised person must now confirm the delete: "decom confirm ${run.id}", or cancel with "decom cancel ${run.id}".` +
        (config.dryRun ? ' (Dry run: confirming will not delete the VM.)' : ''));
      return 'stop';
    },

    async awaiting_destroy_confirm(run) {
      const change = await itsm.getChange(run.change_sys_id);
      if (await followChange(run, change)) return 'continue';
      if (await incidentHold(run)) return 'stop';
      await update(run.id, { next_check_at: later() });
      return 'stop';
    },

    async destroying(run) {
      // The guards in front of the irreversible call, all checked here and not just by which state the
      // run is in.
      const change = await itsm.getChange(run.change_sys_id);
      const blockers = [];
      if (change.status !== 'approved') blockers.push(`${run.change_number} is not approved (${change.status})`);
      if (!run.powered_off_at) blockers.push('the orchestrator never powered this VM off');
      if (!run.soak_ends_at || now() < new Date(run.soak_ends_at)) blockers.push('the soak period is not over');
      if (!run.destroy_confirmed_by) blockers.push('nobody confirmed the delete');
      if (isNeverTouch(run.ci.name)) blockers.push(`${run.ci.name} is on the never-touch list`);
      if (blockers.length) { await needsAttention(run, `delete blocked: ${blockers.join('; ')}.`); return 'stop'; }

      const vm = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid });
      if (!vm) {
        if (!run.destroy_issued_at) { await needsAttention(run, `no VM named ${run.ci.name} on ${run.ci.host.name}, and the orchestrator never deleted it, so nothing was changed.`); return 'stop'; }
        await event(run.id, null, 'vsphere', `${run.ci.name} is gone; the delete issued at ${new Date(run.destroy_issued_at).toISOString()} completed.`);
      } else {
        const drift = driftProblems(run.ci, vm);
        if (drift.length) { await needsAttention(run, `the VM no longer matches the CMDB record (${drift.join('; ')}), so it was not deleted.`); return 'stop'; }
        if (vm.powerState !== 'poweredOff') { await needsAttention(run, `${vm.name} is ${vm.powerState}: someone started it during the soak period, so it was not deleted.`); return 'stop'; }
        if (!run.reclaimed) await update(run.id, { reclaimed: vm.size || {} });
        if (config.dryRun) {
          await event(run.id, null, 'dry_run', `Dry run: ${vm.name} was not deleted.`);
        } else {
          await update(run.id, { destroy_issued_at: now() });
          await event(run.id, run.destroy_confirmed_by, 'vsphere', `Deleting ${vm.name} on ${run.ci.host.name} (confirmed by ${run.destroy_confirmed_by}).`);
          try {
            await hypervisor.destroy(vm, { host: run.ci.host });
          } catch (e) {
            const after = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid }).catch(() => vm);
            if (after) throw e;
            await event(run.id, null, 'vsphere', `The delete call failed (${errText(e)}) but the VM is gone, so the step counts as done.`);
          }
        }
      }
      if (!config.dryRun) await closeTaskOnce(run, DESTROY_TASK, `VM deleted by the decommission orchestrator, confirmed by ${run.destroy_confirmed_by}.`);
      await transition(run, 'retiring', {}, config.dryRun ? 'Dry run: delete skipped.' : `${run.ci.name} deleted.`);
      if (!config.dryRun) await notify(run.id, 'destroyed', `🗑️ ${run.ci.name} deleted from ${run.ci.host.name}.`);
      return 'continue';
    },

    async retiring(run) {
      const fresh = await getRun(run.id);
      const reclaimed = sizeText(fresh.reclaimed);
      if (config.dryRun) {
        // A rehearsal leaves everything as it was: VM back on, CI status back, change closed with a note.
        const vm = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid });
        if (vm && vm.powerState === 'poweredOff') await hypervisor.powerOn(vm, { host: run.ci.host });
        if (run.ci_status_before) await once(`run:${run.id}:ci:restore`, () => itsm.setCiStatus(run.ci, run.ci_status_before).then(() => true));
        await workNoteOnce(run, 'dry-run', `Dry run finished: ${run.ci.name} was not deleted and has been powered back on; CI status restored. Would have reclaimed ${reclaimed}.`);
        await once(`run:${run.id}:change:closed`, () => itsm.setChangeState(run.change_sys_id, 'closed', 'Dry run of the decommission workflow; no VM was deleted.').then(() => true));
        await transition(run, 'completed', { outcome: `Dry run completed; ${run.ci.name} powered back on, nothing deleted.` });
        await notify(run.id, 'summary', `🧪 Dry run of ${run.ci.name} (${run.change_number}) finished. Nothing was deleted; the VM is back on. Would have reclaimed: ${reclaimed}.`);
        return 'stop';
      }
      await once(`run:${run.id}:ci:retired`, () => itsm.setCiStatus(run.ci, 'retired').then(() => true));
      await closeTaskOnce(run, RETIRE_TASK, 'CI retired by the decommission orchestrator.');
      await workNoteOnce(run, 'capacity', `Reclaimed capacity from ${run.ci.name}: ${reclaimed}. Requested by ${run.requested_by}; delete confirmed by ${run.destroy_confirmed_by}.`);
      await closeTaskOnce(run, TRACKER_TASK, `Reclaimed ${reclaimed}; recorded in the change work notes.`);
      await once(`run:${run.id}:change:closed`, () => itsm.setChangeState(run.change_sys_id, 'closed', `${run.ci.name} decommissioned: VM deleted, CI retired.`).then(() => true));
      const elapsedHours = (now() - new Date(run.created_at)) / 3600000;
      await transition(run, 'completed', { outcome: `${run.ci.name} decommissioned; reclaimed ${reclaimed}.` });
      await notify(run.id, 'summary', `🎉 ${run.ci.name} decommissioned. ${run.change_number} closed, CI retired. Reclaimed: ${reclaimed}. Took ${formatDuration(elapsedHours)}.`,
        { changeNumber: run.change_number, reclaimed: fresh.reclaimed });
      return 'stop';
    },

    async cancelling(run) {
      const notes = [];
      if (run.powered_off_at && !run.destroy_issued_at && run.ci) {
        const vm = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid });
        if (vm && vm.powerState === 'poweredOff') {
          await once(`run:${run.id}:vm:power-on`, () => hypervisor.powerOn(vm, { host: run.ci.host }).then(() => true));
          notes.push(`${vm.name} powered back on`);
        }
      }
      if (run.ci_status_before && run.ci) {
        const current = await itsm.getCiStatus(run.ci);
        if (current === 'in_maintenance') { await itsm.setCiStatus(run.ci, run.ci_status_before); notes.push(`CI back to ${run.ci_status_before.replace(/_/g, ' ')}`); }
      }
      if (run.change_sys_id) {
        const change = await itsm.getChange(run.change_sys_id);
        if (!['cancelled', 'closed', 'rejected'].includes(change.status)) {
          await itsm.setChangeState(run.change_sys_id, 'cancelled', `Decommission cancelled. ${run.outcome || ''}`.trim());
        }
      }
      const outcome = `${run.outcome || 'Cancelled.'}${notes.length ? ` ${sentence(notes.join('; '))}` : ''}`;
      await transition(run, 'cancelled', { outcome });
      await notify(run.id, 'cancelled', `🛑 Decommission of ${ciLabel(run)}${run.change_number ? ` (${run.change_number})` : ''} cancelled. ${outcome}`);
      return 'stop';
    },

    async on_hold() { return 'stop'; },
  };

  // An incident against the CI after the power-off puts the VM back on and holds the run for a person.
  async function incidentHold(run) {
    const incidents = await itsm.incidentsSince(run.ci, new Date(run.powered_off_at));
    if (!incidents.length) return false;
    const numbers = incidents.map((i) => i.number).join(', ');
    const vm = await hypervisor.findVm({ host: run.ci.host, name: run.ci.name, uuid: run.ci.uuid });
    if (vm && vm.powerState === 'poweredOff') await hypervisor.powerOn(vm, { host: run.ci.host });
    const msg = `${numbers} raised against ${run.ci.name} during the soak period; the VM was powered back on.`;
    await transition(run, 'on_hold', { attention: msg }, msg);
    await workNoteOnce(run, `hold:${numbers}`, `${msg} The decommission is on hold.`);
    await notify(run.id, `hold:${numbers}`, `⏸️ ${msg} The decommission is on hold: "decom retry ${run.id}" powers it off again and restarts the soak period, "decom cancel ${run.id}" cancels it.`);
    return true;
  }

  // ---------- driving ----------
  async function advance(runId) {
    if (busy.has(runId)) return;
    busy.add(runId);
    try {
      const locked = await db.withRunLock(runId, async () => {
        for (let i = 0; i < 12; i += 1) {
          const run = await getRun(runId);
          if (!run || FINAL.includes(run.state) || run.attention) return;
          const step = steps[run.state];
          if (!step) return;
          let result;
          try {
            result = await step(run);
          } catch (e) {
            if (e instanceof DecomError && e.status === 409) return; // lost a race; the winner carries on
            if (VM_CHANGING.includes(run.state)) {
              await needsAttention(run, `${STATE_LABELS[run.state]} failed: ${errText(e)}`);
            } else {
              // Reads and idempotent writes (ServiceNow asleep, network blip): try again on the next poll.
              const last = (await db.query('SELECT message FROM decom_events WHERE run_id = $1 ORDER BY id DESC LIMIT 1', [runId])).rows[0];
              const message = `${STATE_LABELS[run.state]}: ${errText(e)} Will try again.`;
              if (!last || last.message !== message) await event(runId, null, 'error', message);
              await update(runId, { next_check_at: later() });
            }
            return;
          }
          if (result === 'wait') { await update(runId, { next_check_at: later() }); return; }
          if (result !== 'continue') return;
        }
      });
      return locked;
    } catch (e) {
      log.error(`advance(${runId}) failed:`, e.message);
    } finally {
      busy.delete(runId);
    }
  }

  const kick = (runId) => { if (autoKick) setImmediate(() => { advance(runId).catch(() => {}); }); };

  // Every due run, then every message waiting for delivery. Called on a timer and at startup, which is
  // also how interrupted runs resume.
  async function tick() {
    const { rows } = await db.query(`SELECT id FROM decom_runs WHERE state <> ALL($1) AND attention IS NULL AND next_check_at <= $2 ORDER BY id`, [FINAL, now()]);
    for (const r of rows) await advance(r.id);
    await deliver();
  }

  async function deliver() {
    const { rows } = await db.query(`SELECT * FROM outbox WHERE status = 'pending' AND next_try_at <= $1 ORDER BY id LIMIT 50`, [now()]);
    for (const m of rows) {
      try {
        await notifier.send({ runId: m.run_id, key: m.key, message: m.message, data: m.data });
        await db.query(`UPDATE outbox SET status = 'sent', sent_at = $2, attempts = attempts + 1 WHERE id = $1`, [m.id, now()]);
      } catch (e) {
        const wait = Math.min(600, 5 * 2 ** Math.min(m.attempts, 7));
        await db.query('UPDATE outbox SET attempts = attempts + 1, last_error = $2, next_try_at = $3 WHERE id = $1',
          [m.id, String(e.message).slice(0, 500), new Date(now().getTime() + wait * 1000)]);
        break; // keep messages in order: the rest wait for this one
      }
    }
  }

  // ---------- actions (from the CLI, the HTTP API and, later, Teams) ----------
  const norm = (who) => String(who || '').trim();
  const isConfirmer = (who) => config.confirmers.includes(norm(who).toLowerCase());

  async function mustGet(runId) {
    const run = await getRun(Number(runId));
    if (!run) throw new DecomError(404, `No decommission run ${runId}.`);
    return run;
  }

  async function request({ server, actor }) {
    const who = norm(actor);
    if (!who) throw new DecomError(400, 'Say who is asking.');
    const name = String(server || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new DecomError(400, 'Give a server name or IP address (letters, digits, dot, hyphen, underscore).');
    if (config.requesters.length && !config.requesters.includes(who.toLowerCase())) throw new DecomError(403, `${who} may not request decommissions.`);
    if (isNeverTouch(name)) throw new DecomError(422, `${name} is on the never-touch list.`);
    let run;
    try {
      ({ rows: [run] } = await db.query(`INSERT INTO decom_runs (server, state, requested_by, created_at, updated_at, next_check_at)
        VALUES ($1, 'validating', $2, $3, $3, $3) RETURNING *`, [name, who, now()]));
    } catch (e) {
      if (/decom_runs_one_active|duplicate key/.test(e.message)) {
        const { rows } = await db.query(`SELECT id, state FROM decom_runs WHERE lower(server) = lower($1) AND state <> ALL($2)`, [name, FINAL]);
        throw new DecomError(409, `${name} already has a decommission in progress (run ${rows[0] && rows[0].id}: ${rows[0] ? STATE_LABELS[rows[0].state] : ''}).`);
      }
      throw e;
    }
    await event(run.id, who, 'request', `${who} asked to decommission ${name}.`);
    await notify(run.id, 'received', `📥 Request received from ${who}: decommission ${name} (run ${run.id}). Checking the CMDB and vSphere.`);
    kick(run.id);
    return run;
  }

  async function precheck({ runId, task, outcome, actor, reason }) {
    const run = await mustGet(runId);
    const who = norm(actor);
    if (!who) throw new DecomError(400, 'Say who is acting.');
    if (run.state !== 'prechecks') throw new DecomError(409, `Run ${run.id} is not waiting for pre-checks (${STATE_LABELS[run.state]}).`);
    if (!['done', 'skipped', 'skip'].includes(outcome)) throw new DecomError(400, 'Outcome is done or skip.');
    const index = Number(task);
    const name = Number.isInteger(index) && index >= 1 && index <= MANUAL_TASKS.length ? MANUAL_TASKS[index - 1]
      : MANUAL_TASKS.find((n) => n.toLowerCase() === String(task).toLowerCase());
    if (!name) throw new DecomError(400, `Pre-check is 1-${MANUAL_TASKS.length}: ${MANUAL_TASKS.map((n, i) => `${i + 1} ${n}`).join(', ')}.`);
    if ((outcome === 'skip' || outcome === 'skipped') && !String(reason || '').trim()) throw new DecomError(400, 'Skipping a pre-check needs a reason.');
    const t = (await itsm.listTasks(run.change_sys_id)).find((x) => x.name === name);
    if (!t) throw new DecomError(422, `${run.change_number} has no task "${name}".`);
    if (t.status !== 'open') throw new DecomError(409, `${t.number} (${name}) is already ${t.status}.`);
    const result = outcome === 'done' ? 'done' : 'skipped';
    await itsm.closeTask(t.sysId, result, `${result === 'done' ? 'Completed' : 'Skipped'} by ${who} through the decommission orchestrator.${reason ? ` ${reason}` : ''}`);
    await event(run.id, who, 'precheck', `${who} marked "${name}" ${result}${reason ? `: ${reason}` : ''}.`);
    await update(run.id, { next_check_at: now() });
    kick(run.id);
    return { task: t.number, name, outcome: result };
  }

  async function confirmDestroy({ runId, actor }) {
    const run = await mustGet(runId);
    const who = norm(actor);
    if (!isConfirmer(who)) throw new DecomError(403, `${who || 'This person'} is not allowed to confirm deletes.`);
    if (!config.requesterMayConfirm && who.toLowerCase() === run.requested_by.toLowerCase()) throw new DecomError(403, 'The person who requested a decommission cannot confirm its delete.');
    if (run.state !== 'awaiting_destroy_confirm') throw new DecomError(409, `Run ${run.id} is not waiting for a delete confirmation (${STATE_LABELS[run.state]}).`);
    const updated = await transition(run, 'destroying', { destroy_confirmed_by: who, destroy_confirmed_at: now() }, `${who} confirmed the delete.`);
    await event(run.id, who, 'confirm', `${who} confirmed the delete of ${run.ci.name}.`);
    kick(run.id);
    return updated;
  }

  async function cancel({ runId, actor, reason }) {
    const run = await mustGet(runId);
    const who = norm(actor);
    if (!who) throw new DecomError(400, 'Say who is acting.');
    if (who.toLowerCase() !== run.requested_by.toLowerCase() && !isConfirmer(who)) throw new DecomError(403, `${who} may not cancel run ${run.id}.`);
    if (!CANCELLABLE.includes(run.state)) throw new DecomError(409, `Run ${run.id} can no longer be cancelled (${STATE_LABELS[run.state]}).`);
    const updated = await update(run.id, { state: 'cancelling', attention: null, next_check_at: now(), outcome: `Cancelled by ${who}${reason ? `: ${reason}` : ''}.` }, run.state);
    if (!updated) throw new DecomError(409, `Run ${run.id} changed state; try again.`);
    await event(run.id, who, 'cancel', `${who} cancelled the decommission${reason ? `: ${reason}` : ''}.`);
    kick(run.id);
    return updated;
  }

  async function retry({ runId, actor }) {
    const run = await mustGet(runId);
    const who = norm(actor);
    if (!isConfirmer(who)) throw new DecomError(403, `${who || 'This person'} may not retry steps.`);
    if (!run.attention) throw new DecomError(409, `Run ${run.id} is not waiting for attention.`);
    const fields = { attention: null, next_check_at: now() };
    if (run.state === 'on_hold') Object.assign(fields, { state: 'powering_off', powered_off_at: null, soak_ends_at: null });
    const updated = await update(run.id, fields, run.state);
    if (!updated) throw new DecomError(409, `Run ${run.id} changed state; try again.`);
    await event(run.id, who, 'retry', run.state === 'on_hold' ? `${who} resumed the decommission: power off again and restart the soak period.` : `${who} asked to retry: ${STATE_LABELS[run.state]}.`);
    kick(run.id);
    return updated;
  }

  async function status(query) {
    const q = String(query || '').trim();
    let rows;
    if (/^\d+$/.test(q)) rows = (await db.query('SELECT * FROM decom_runs WHERE id = $1', [Number(q)])).rows;
    else if (/^CHG\d+$/i.test(q)) rows = (await db.query('SELECT * FROM decom_runs WHERE upper(change_number) = upper($1) ORDER BY id DESC LIMIT 1', [q])).rows;
    else rows = (await db.query(`SELECT * FROM decom_runs WHERE lower(server) = lower($1) OR lower(ci->>'name') = lower($1) OR ci->>'ip' = $1 ORDER BY id DESC LIMIT 1`, [q])).rows;
    if (!rows[0]) return null;
    const run = rows[0];
    const events = (await db.query('SELECT at, actor, kind, message FROM decom_events WHERE run_id = $1 ORDER BY id', [run.id])).rows;
    return { run, label: STATE_LABELS[run.state] || run.state, events };
  }

  async function list({ all = false } = {}) {
    const { rows } = all
      ? await db.query('SELECT * FROM decom_runs ORDER BY id DESC LIMIT 50')
      : await db.query('SELECT * FROM decom_runs WHERE state <> ALL($1) ORDER BY id', [FINAL]);
    return rows.map((run) => ({ ...run, label: STATE_LABELS[run.state] || run.state }));
  }

  async function messages(limit = 50) {
    const { rows } = await db.query('SELECT run_id, message, status, created_at FROM outbox ORDER BY id DESC LIMIT $1', [limit]);
    return rows.reverse();
  }

  return { request, precheck, confirmDestroy, cancel, retry, status, list, messages, advance, tick, deliver, getRun };
}

module.exports = { createEngine, DecomError, TASKS, MANUAL_TASKS, STATE_LABELS, driftProblems, formatDuration, sizeText };
