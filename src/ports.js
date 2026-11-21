// The three ports the workflow engine talks through. Each has one real adapter (src/adapters) and
// one fake (src/adapters/fake) used by the tests; the engine never knows which it has.
//
// ITSM (ServiceNow):
//   findCis(query)                         -> [Ci]   by name or IP, any status (the engine decides)
//   findHost(ci)                           -> { sysId, name, ip } | null   the hypervisor host it runs on
//   openWork(ci, { exceptChangeSysId })    -> { incidents: [{ number }], changes: [{ number }] }
//   createChange({ correlationId, ci, requester, taskNames, start, end })
//                                          -> { sysId, number, approvalRequested, note }
//                                             (must return the existing change for a correlationId it has seen)
//   findChange(correlationId)              -> { sysId, number } | null
//   getChange(sysId)                       -> { number, status: pending|approved|rejected|cancelled|closed }
//   listTasks(changeSysId)                 -> [{ sysId, number, name, status: open|done|skipped }]
//   closeTask(taskSysId, outcome, note)    outcome: done | skipped
//   setChangeState(sysId, state, note)     state: implement | review | closed | cancelled
//   addWorkNote(sysId, text)
//   getCiStatus(ci) -> status; setCiStatus(ci, status)
//                                          status: installed | in_maintenance | retired | (other words kept as read)
//   incidentsSince(ci, date)               -> [{ number }]
//   changeLink(change)                     -> URL for people
//   Ci = { sysId, name, ip, uuid, status, className, size: { cpu, memoryMb, diskGb } }
//
// Hypervisor (vSphere: standalone ESXi or vCenter):
//   findVm({ host, name, uuid })           -> Vm | null; throws if more than one VM matches. Errors that will
//                                             not go away by retrying (ambiguous, unusable name) carry .refuse = true
//   shutdown(vm, { host, timeoutSeconds }) -> 'already_off' | 'graceful' | 'hard'   (verified off)
//   powerOn(vm, { host })
//   destroy(vm, { host })                  (verified gone)
//   Vm = { ref, name, uuid, instanceUuid, ip, powerState: poweredOn|poweredOff|suspended, size: { cpu, memoryMb, diskGb } }
//
// Notifier (Teams later; the console notifier keeps messages for `decom log`):
//   send({ runId, key, message, data })    throws on failure; the outbox retries, unless the error has
//                                             .permanent = true (then the message is set aside)
module.exports = {};
