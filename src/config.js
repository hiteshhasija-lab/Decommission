// All settings come from the environment. On the orchestrator VM they live in /etc/decom/decom.env
// (root-only, mode 600), which systemd hands to the container; secrets are never baked into the image
// or committed. See deploy/decom.env.example for every setting with its default.

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

function load(env = process.env) {
  const cfg = {
    port: num(env.PORT, 8080),
    databaseUrl: env.DATABASE_URL || '',
    apiToken: env.DECOM_API_TOKEN || '',

    // Safety. Dry run (the default) runs every step except the VM delete.
    dryRun: bool(env.DECOM_DRY_RUN, true),
    soakHours: num(env.DECOM_SOAK_HOURS, 24),
    pollSeconds: num(env.DECOM_POLL_SECONDS, 60),
    shutdownTimeoutSeconds: num(env.DECOM_SHUTDOWN_TIMEOUT_SECONDS, 180),
    // When a run counts as stuck: a working step (checking, shutting down, deleting...) longer than
    // stuckMinutes; waiting for approval, pre-checks or the delete confirmation longer than
    // stuckWaitHours; waiting for a person after a failure longer than stuckAttentionHours.
    stuckMinutes: num(env.DECOM_STUCK_MINUTES, 30),
    stuckWaitHours: num(env.DECOM_STUCK_WAIT_HOURS, 72),
    stuckAttentionHours: num(env.DECOM_STUCK_ATTENTION_HOURS, 24),
    // Never decommissioned, whatever the CMDB says: the orchestrator's own VM first of all.
    neverTouch: [...new Set(['DECOM', ...list(env.DECOM_NEVER_TOUCH)].map((s) => s.toLowerCase()))],

    // Who may do what (until Entra ID groups arrive with the Teams integration). Approval itself
    // happens in ServiceNow under the approver's own login.
    requesters: list(env.DECOM_REQUESTERS).map((s) => s.toLowerCase()), // empty = anyone may request
    confirmers: list(env.DECOM_CONFIRMERS).map((s) => s.toLowerCase()), // empty = nobody may confirm a delete
    requesterMayConfirm: bool(env.DECOM_REQUESTER_MAY_CONFIRM, false),

    itsm: env.DECOM_ITSM || 'servicenow',
    servicenow: {
      instance: (env.SN_INSTANCE || '').replace(/\/+$/, ''),
      user: env.SN_USER || '',
      password: env.SN_PASSWORD || '',
      ciClass: env.SN_CI_CLASS || 'cmdb_ci_vmware_instance',
      hostClass: env.SN_HOST_CLASS || 'cmdb_ci_esx_server',
      assignmentGroup: env.SN_ASSIGNMENT_GROUP || '',
      timeoutMs: num(env.SN_TIMEOUT_SECONDS, 30) * 1000,
    },

    hypervisor: env.DECOM_HYPERVISOR || 'govc',
    vsphere: {
      // esxi: connect to the host the CMDB names for the VM (standalone hosts, as in the lab).
      // vcenter: connect to one vCenter for every VM.
      mode: env.VSPHERE_MODE || 'esxi',
      url: env.VSPHERE_URL || '',
      user: env.VSPHERE_USER || '',
      password: env.VSPHERE_PASSWORD || '',
      insecure: bool(env.VSPHERE_INSECURE, false),
      allowedHosts: list(env.VSPHERE_ALLOWED_HOSTS),
    },

    notifier: env.DECOM_NOTIFIER || 'console',
    teamsWorkflowUrl: env.TEAMS_WORKFLOW_URL || '',
  };
  return cfg;
}

// What is missing for the service to do real work, in plain words (shown by /healthz and `decom health`).
function problems(cfg) {
  const out = [];
  if (!cfg.databaseUrl) out.push('DATABASE_URL is not set');
  if (!cfg.apiToken) out.push('DECOM_API_TOKEN is not set');
  if (cfg.itsm === 'servicenow') {
    const sn = cfg.servicenow;
    if (!sn.instance || !sn.user || !sn.password) out.push('ServiceNow is not configured (SN_INSTANCE, SN_USER, SN_PASSWORD)');
  }
  if (cfg.hypervisor === 'govc') {
    const v = cfg.vsphere;
    if (!v.user || !v.password) out.push('vSphere credentials are not set (VSPHERE_USER, VSPHERE_PASSWORD)');
    if (v.mode === 'vcenter' && !v.url) out.push('VSPHERE_MODE=vcenter needs VSPHERE_URL');
  }
  if (cfg.notifier === 'teams-workflow' && !cfg.teamsWorkflowUrl) out.push('DECOM_NOTIFIER=teams-workflow needs TEAMS_WORKFLOW_URL');
  if (!cfg.confirmers.length) out.push('DECOM_CONFIRMERS is empty, so nobody can confirm a delete');
  return out;
}

module.exports = { load, problems };
