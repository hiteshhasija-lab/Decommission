# Decommission orchestrator

A small standalone service that decommissions virtual servers through the systems an enterprise
already has:

- **ServiceNow** is the system of record: the CI in the CMDB, the change and its tasks, the approval,
  incidents raised during the soak period, work notes, and the CI's retirement.
- **VMware vSphere** (a standalone ESXi host or vCenter, through govc) is where the VM is found, shut
  down, powered back on if the decommission is cancelled, and deleted.
- **Microsoft Teams** is where people ask and are kept informed. Until the Teams integration is built,
  requests and decisions go through the `decom` command on the orchestrator VM, and messages are kept
  for `decom log` (or posted to a Teams Workflows webhook).

It has no ticketing or chat system of its own, and keeps only workflow state in its own PostgreSQL
database.

## The workflow

| # | Step | What happens |
|---|------|--------------|
| 1 | Request | `decom request <server>` (later, "decommission <server>" in Teams). |
| 2 | Validate | Exactly one CMDB record, not retired, not on the never-touch list, a host relationship, no open incidents or changes, exactly one matching VM in vSphere, and the CMDB and vSphere agree on name, UUID and IP (drift check). Otherwise the request is refused and nothing is touched. |
| 3 | Change | A normal change with the CI and seven change tasks, moved to Assess to request approval. |
| 4 | **Checkpoint 1: approval** | In ServiceNow, under the approver's own login. The orchestrator polls the change. Rejection ends the run. On approval the CI goes to *In maintenance*. |
| 5 | Pre-checks | Backup, monitoring, DNS/firewall: close each task in ServiceNow (Closed = done, Cancelled = skipped) or with `decom precheck`. |
| 6 | Shut down | Graceful guest shutdown through VMware Tools, hard power-off after a timeout, verified off. Once, however often the step runs. |
| 7 | Soak period | Default 24 hours. An incident against the CI in that time powers the VM back on and holds the run. |
| 8 | **Checkpoint 2: confirm** | `decom confirm <run>` by a listed confirmer who did not request it. |
| 9 | Delete | Size read first, delete issued, verified gone. Never retried automatically after a failure. |
| 10 | Retire and close | CI retired, reclaimed capacity in the work notes, change closed, summary message. |

Cancel (`decom cancel`) is possible until the delete starts: it powers the VM back on, puts the CI's
status back and cancels the change.

**Dry run is on by default** (`DECOM_DRY_RUN=true`): every step runs except the delete, and at the
end the VM is powered back on, the CI status restored and the change closed with a note.

### Guards

- Change-gated: no shutdown, power-on or delete without an approved change.
- Pre-check gate; one power-off even if two actions race (state changes are compare-and-set in the database).
- The delete re-checks everything itself: approved change, the orchestrator powered the VM off, soak over, confirmed by an authorised person, VM still off and still the same VM.
- Lost answers: after a failed call the step looks at the VM's real state before deciding.
- Restart resume: every state and timer is in the database; interrupted runs continue after a restart.
- Steps that change a VM are never retried automatically after a failure: the run waits for `decom retry`.
- Never-touch list, always including the orchestrator's own VM (`DECOM`).
- Chat messages go through an outbox that retries until delivered, in order.

## Layout

```
src/engine.js           the workflow (state machine, guards, actions)
src/ports.js            the three interfaces the engine uses
src/adapters/           servicenow.js, vsphere-govc.js, notifiers.js, fake/ (for tests)
src/server.js           HTTP API + scheduler;  src/cli.js  the `decom` command
src/migrations/         database schema
deploy/                 Containerfile companions: Quadlet units, backup timer, install.sh
test/                   workflow, adapter and API tests (in-memory Postgres via PGlite)
```

## Install on the orchestrator VM (RHEL 10 with Podman)

From a checkout, as root on the VM:

```bash
bash deploy/install.sh
```

It creates `/etc/decom/decom.env` (root-only) with a generated database password and API token, builds
the image, installs the systemd units (`decom-postgres`, `decom-app`, nightly `decom-backup.timer`)
and the `decom` command. Then fill in ServiceNow, vSphere and `DECOM_CONFIRMERS` in
`/etc/decom/decom.env` and run `systemctl restart decom-app`. `decom check 10.0.0.65` tests both
connections without changing anything.

### ServiceNow set-up

- An integration user with the `itil` role (Web service access only), time zone **GMT**.
- CIs in `cmdb_ci_vmware_instance` (name, IP address, VM instance UUID) related to a
  `cmdb_ci_esx_server` CI with the host's IP address (any relationship type, either direction).

## Tests

```bash
npm ci && npm test
```
