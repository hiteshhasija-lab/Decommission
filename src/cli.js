#!/usr/bin/env node
// `decom` — the operator's command line on the orchestrator VM. It talks to the running service's
// HTTP API (so every step runs in the one service process), except `check`, which tests the
// connections directly and changes nothing.
const config = require('./config');

const HELP = `decom — server decommission orchestrator

  decom request <server> --as <you>             start a decommission (validates, creates the change)
  decom list [--all]                            live runs (--all: the last 50, finished too)
  decom status <server | CHG number | run>      where a run is, with its history
  decom precheck <run> <1-3> done|skip --as <you> [--reason "..."]
                                                close a pre-check task (or close it in ServiceNow)
                                                1 Verify backup completed, 2 Remove from monitoring, 3 DNS / firewall cleanup
  decom confirm <run> --as <you>                checkpoint 2: confirm the delete after the soak period
  decom cancel <run> --as <you> [--reason "..."] cancel; powers the VM back on if it was shut down
  decom retry <run> --as <you>                  after a failed step has been looked at (or resume an on-hold run)
  decom say "<chat text>" --as <you>            what a chat message would do ("decommission X", "status X")
  decom log [count]                             the messages sent to the channel
  decom health                                  service health and what is not configured
  decom check [host IP]                         test ServiceNow and vSphere (read-only)

  --as can be left out when DECOM_ACTOR is set.`;

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--as') out.as = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

async function call(cfg, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => { throw new Error(`The decommission service is not answering on port ${cfg.port} (${e.cause ? e.cause.code : e.message}).`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const t = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
function row(r) {
  const name = r.ci ? r.ci.name : r.server;
  return `${String(r.id).padStart(4)}  ${name.padEnd(20)} ${(r.change_number || '').padEnd(11)} ${r.label}${r.attention ? `  ⚠ ${r.attention}` : ''}${r.stuck && !r.attention ? `  ⏰ ${r.stuck}` : ''}`;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const cfg = config.load();
  const [cmd, ...rest] = args._;
  const actor = args.as || process.env.DECOM_ACTOR || '';
  const needActor = () => { if (!actor) throw new Error('Say who you are with --as <name>.'); return actor; };
  if (!cmd || args.help || cmd === 'help') { console.log(HELP); return; }

  switch (cmd) {
    case 'request': {
      if (!rest[0]) throw new Error('Usage: decom request <server> --as <you>');
      const run = await call(cfg, 'POST', '/api/requests', { server: rest[0], actor: needActor() });
      console.log(`Run ${run.id} started for ${run.server}. Follow it with: decom status ${run.id}`);
      break;
    }
    case 'list': {
      const runs = await call(cfg, 'GET', `/api/runs${args.all ? '?all=1' : ''}`);
      if (!runs.length) console.log(args.all ? 'No runs yet.' : 'No live decommissions.');
      for (const r of runs) console.log(row(r));
      break;
    }
    case 'status': {
      if (!rest[0]) throw new Error('Usage: decom status <server | CHG number | run>');
      const s = await call(cfg, 'GET', `/api/status/${encodeURIComponent(rest[0])}`);
      const r = s.run;
      console.log(`Run ${r.id}: ${r.ci ? r.ci.name : r.server}${r.change_number ? `, ${r.change_number}` : ''}`);
      console.log(`State: ${s.label}${r.attention ? `\nNeeds attention: ${r.attention}` : ''}${r.outcome ? `\nOutcome: ${r.outcome}` : ''}`);
      if (r.soak_ends_at && !r.finished_at) console.log(`Soak period ends: ${t(r.soak_ends_at)} UTC`);
      console.log('History:');
      for (const e of s.events) console.log(`  ${t(e.at)}  ${e.actor === 'orchestrator' ? '' : `[${e.actor}] `}${e.message}`);
      break;
    }
    case 'precheck': {
      const [id, task, outcome] = rest;
      if (!id || !task || !outcome) throw new Error('Usage: decom precheck <run> <1-3> done|skip --as <you> [--reason "..."]');
      const r = await call(cfg, 'POST', `/api/runs/${id}/prechecks/${encodeURIComponent(task)}`, { outcome, actor: needActor(), reason: args.reason });
      console.log(`${r.task} (${r.name}) marked ${r.outcome}.`);
      break;
    }
    case 'confirm': {
      if (!rest[0]) throw new Error('Usage: decom confirm <run> --as <you>');
      await call(cfg, 'POST', `/api/runs/${rest[0]}/confirm-destroy`, { actor: needActor() });
      console.log(`Delete confirmed for run ${rest[0]}. Follow it with: decom status ${rest[0]}`);
      break;
    }
    case 'cancel': {
      if (!rest[0]) throw new Error('Usage: decom cancel <run> --as <you>');
      await call(cfg, 'POST', `/api/runs/${rest[0]}/cancel`, { actor: needActor(), reason: args.reason });
      console.log(`Cancelling run ${rest[0]}. Follow it with: decom status ${rest[0]}`);
      break;
    }
    case 'retry': {
      if (!rest[0]) throw new Error('Usage: decom retry <run> --as <you>');
      await call(cfg, 'POST', `/api/runs/${rest[0]}/retry`, { actor: needActor() });
      console.log(`Retrying run ${rest[0]}. Follow it with: decom status ${rest[0]}`);
      break;
    }
    case 'say': {
      const r = await call(cfg, 'POST', '/api/command', { text: rest.join(' '), actor: needActor() });
      console.log(r.reply);
      break;
    }
    case 'log': {
      const msgs = await call(cfg, 'GET', `/api/messages?limit=${Number(rest[0]) || 30}`);
      for (const m of msgs) console.log(`${t(m.created_at)}  run ${m.run_id}  ${m.status === 'sent' ? '' : '(not delivered yet) '}${m.message}`);
      break;
    }
    case 'health': {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`).catch(() => null);
      if (!res) throw new Error('The decommission service is not answering.');
      const h = await res.json();
      console.log(`Service ${h.version}: ${h.ok ? 'running, database OK' : 'database NOT reachable'}. Dry run: ${h.dryRun ? 'ON (VMs are never deleted)' : 'off'}. Soak: ${h.soakHours} h. Notifier: ${h.notifier}.`);
      for (const p of h.problems) console.log(`  - ${p}`);
      if (h.stuck && h.stuck.length) {
        console.log('Stuck runs:');
        for (const s of h.stuck) console.log(`  ⏰ run ${s.id} (${s.server}) ${s.reason}`);
      }
      break;
    }
    case 'check': {
      const { adapters } = require('./app');
      const { itsm, hypervisor } = adapters(cfg);
      if (config.problems(cfg).some((p) => /ServiceNow/.test(p))) {
        console.log('ServiceNow: not configured (SN_INSTANCE, SN_USER, SN_PASSWORD).');
      } else {
        try {
          const c = await itsm.check();
          console.log(`ServiceNow: connected as ${c.user}; time zone ${c.timeZone}; can read CIs and changes.`);
          if (!/^(GMT|UTC|Etc\/UTC|Etc\/GMT)$/i.test(c.timeZone)) console.log('  Set this user\'s time zone to GMT in ServiceNow: the orchestrator works in UTC.');
        } catch (e) { console.log(`ServiceNow: FAILED — ${e.message}`); }
      }
      const hostIp = rest[0];
      if (!hostIp && cfg.vsphere.mode !== 'vcenter') {
        console.log('vSphere: give a host IP to test it (decom check 10.0.0.65).');
      } else if (!cfg.vsphere.user || !cfg.vsphere.password) {
        console.log('vSphere: not configured (VSPHERE_USER, VSPHERE_PASSWORD).');
      } else {
        try {
          console.log(`vSphere: ${await hypervisor.about({ ip: hostIp, name: hostIp })}.`);
        } catch (e) { console.log(`vSphere: FAILED — ${e.message}`); }
      }
      break;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run decom help.`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
