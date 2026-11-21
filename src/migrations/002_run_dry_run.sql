-- Dry run is decided once, when a run is requested, so changing DECOM_DRY_RUN later never mixes the two
-- modes inside one run (a dry run that retires the CI, or a real run that restores it).
ALTER TABLE decom_runs ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT true;
