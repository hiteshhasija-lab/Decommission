-- Workflow state only. The CMDB, the change and its tasks stay in ServiceNow, which is authoritative;
-- a run keeps just the identifiers and the identity snapshot it validated against.

CREATE TABLE IF NOT EXISTS decom_runs (
  id                    bigserial PRIMARY KEY,
  server                text NOT NULL,              -- as requested
  state                 text NOT NULL,              -- see src/engine.js STATES
  requested_by          text NOT NULL,
  ci                    jsonb,                      -- CMDB record at validation: sys_id, name, ip, uuid, host
  vm                    jsonb,                      -- the VM as vSphere showed it at validation
  change_sys_id         text,
  change_number         text,
  ci_status_before      text,                       -- install_status before maintenance, restored on cancel
  powered_off_at        timestamptz,
  soak_ends_at          timestamptz,
  destroy_confirmed_by  text,
  destroy_confirmed_at  timestamptz,
  destroy_issued_at     timestamptz,
  reclaimed             jsonb,                      -- { cpu, memoryMb, diskGb } read before the delete
  attention             text,                       -- set when a step failed: waits for a person (decom retry)
  outcome               text,                       -- final words for a finished run
  next_check_at         timestamptz NOT NULL DEFAULT now(),  -- durable timer: when the scheduler looks again
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz
);

-- One live decommission per server.
CREATE UNIQUE INDEX IF NOT EXISTS decom_runs_one_active
  ON decom_runs (lower(server))
  WHERE state NOT IN ('completed', 'rejected', 'cancelled', 'refused');
CREATE INDEX IF NOT EXISTS decom_runs_due ON decom_runs (next_check_at)
  WHERE state NOT IN ('completed', 'rejected', 'cancelled', 'refused');

-- Append-only audit: every state change, external call and human action.
CREATE TABLE IF NOT EXISTS decom_events (
  id       bigserial PRIMARY KEY,
  run_id   bigint NOT NULL REFERENCES decom_runs(id),
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,                           -- a person, or 'orchestrator'
  kind     text NOT NULL,
  message  text NOT NULL,
  data     jsonb
);
CREATE INDEX IF NOT EXISTS decom_events_run ON decom_events (run_id, id);

-- Notification outbox (the card ledger of the bot design): each message is recorded once under its
-- key and delivered until the chat system accepts it.
CREATE TABLE IF NOT EXISTS outbox (
  id          bigserial PRIMARY KEY,
  run_id      bigint REFERENCES decom_runs(id),
  key         text NOT NULL UNIQUE,
  message     text NOT NULL,
  data        jsonb,
  status      text NOT NULL DEFAULT 'pending',      -- pending | sent
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (next_try_at) WHERE status = 'pending';

-- External writes already made, so a step that runs again does not repeat them.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         text PRIMARY KEY,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
