-- When the run entered its current state, and when it started waiting for a person, so runs that sit
-- too long can be flagged (decom health, /healthz and a chat message).
ALTER TABLE decom_runs ADD COLUMN IF NOT EXISTS state_since timestamptz;
ALTER TABLE decom_runs ADD COLUMN IF NOT EXISTS attention_at timestamptz;
UPDATE decom_runs SET state_since = updated_at WHERE state_since IS NULL;
UPDATE decom_runs SET attention_at = updated_at WHERE attention IS NOT NULL AND attention_at IS NULL;
