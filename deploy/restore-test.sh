#!/usr/bin/bash
# Proves the nightly backups can be used: restores the newest dump into a throwaway PostgreSQL container
# (no network), compares every table's row count and the schema migrations with the live database, then
# removes the container. The live database is only read. Run as root on the orchestrator VM:
#   decom-restore-test            (takes a fresh backup first)
#   decom-restore-test <file>     (tests that backup file)
set -euo pipefail
dir=/var/lib/decom/backups
name=decom-restore-test
if [ $# -ge 1 ]; then
  file=$1
else
  systemctl start decom-backup.service
  file=$(ls -1t "$dir"/decom-*.sql.gz | head -1)
fi
[ -s "$file" ] || { echo "No backup file to test."; exit 1; }
gzip -t "$file"
echo "Backup: $file ($(du -h "$file" | cut -f1))"

cleanup() { podman rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
podman run -d --rm --name "$name" --network none \
  -e POSTGRES_USER=decom -e POSTGRES_DB=decom -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" \
  docker.io/library/postgres:16 >/dev/null
for i in $(seq 1 60); do
  podman exec "$name" pg_isready -U decom -d decom -q 2>/dev/null && \
    podman exec "$name" psql -U decom -d decom -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
gunzip -c "$file" | podman exec -i "$name" psql -U decom -d decom -q -v ON_ERROR_STOP=1 >/dev/null
echo "Restored into a scratch database."

q() { podman exec "$1" psql -U decom -d decom -tAc "$2"; }
tables=$(q decom-postgres "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
fail=0
printf '%-22s %8s %8s\n' table live restored
for t in $tables; do
  live=$(q decom-postgres "SELECT count(*) FROM \"$t\"")
  rest=$(q "$name" "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo missing)
  mark=""; [ "$live" = "$rest" ] || { mark="  <-- differs"; fail=1; }
  printf '%-22s %8s %8s%s\n' "$t" "$live" "$rest" "$mark"
done
mig_live=$(q decom-postgres 'SELECT string_agg(name, chr(44) ORDER BY name) FROM schema_migrations')
mig_rest=$(q "$name" 'SELECT string_agg(name, chr(44) ORDER BY name) FROM schema_migrations' 2>/dev/null || echo missing)
echo "Migrations: live $mig_live; restored $mig_rest"
[ -n "$mig_live" ] && [ "$mig_live" = "$mig_rest" ] || { echo "Schema migrations differ."; fail=1; }
if [ $fail = 0 ]; then echo "RESTORE TEST PASSED: every table restored with the same number of rows."; else echo "RESTORE TEST FAILED (a difference can also be a change made since the backup)."; exit 1; fi
