// Wires the engine to its adapters from the configuration. Used by the server and by `decom check`.
const { createServiceNow } = require('./adapters/servicenow');
const { createVsphere } = require('./adapters/vsphere-govc');
const { consoleNotifier, teamsWorkflowNotifier } = require('./adapters/notifiers');

function adapters(cfg, log = console) {
  if (cfg.itsm !== 'servicenow') throw new Error(`Unknown DECOM_ITSM "${cfg.itsm}" (only servicenow is supported)`);
  if (cfg.hypervisor !== 'govc') throw new Error(`Unknown DECOM_HYPERVISOR "${cfg.hypervisor}" (only govc is supported)`);
  const notifier = cfg.notifier === 'teams-workflow' ? teamsWorkflowNotifier(cfg.teamsWorkflowUrl) : consoleNotifier(log);
  return { itsm: createServiceNow(cfg), hypervisor: createVsphere(cfg), notifier };
}

module.exports = { adapters };
