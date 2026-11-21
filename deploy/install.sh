#!/usr/bin/bash
# Installs or upgrades the decommission orchestrator on this VM (RHEL with Podman). Run as root from an
# unpacked release directory:  bash deploy/install.sh
# Creates /etc/decom with generated database password and API token (never printed), builds the image,
# installs the systemd (Quadlet) units and the `decom` command, and starts the service. Re-running it
# upgrades the image and keeps the settings and the data.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
command -v podman >/dev/null || { echo "Podman is required (dnf install -y podman)."; exit 1; }
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)

umask 077
install -d -m 700 /etc/decom
gen() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40; }
if [ ! -f /etc/decom/postgres.env ]; then
  pw=$(gen)
  printf 'POSTGRES_USER=decom\nPOSTGRES_DB=decom\nPOSTGRES_PASSWORD=%s\n' "$pw" > /etc/decom/postgres.env
  sed -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://decom:${pw}@decom-postgres:5432/decom#" \
      -e "s#^DECOM_API_TOKEN=.*#DECOM_API_TOKEN=$(gen)#" deploy/decom.env.example > /etc/decom/decom.env
  unset pw
  echo "Created /etc/decom/decom.env (fill in ServiceNow, vSphere and confirmers)."
fi
chmod 600 /etc/decom/*.env
umask 022

echo "Building localhost/decom-orchestrator:${version} ..."
podman build -q -t "localhost/decom-orchestrator:${version}" -t localhost/decom-orchestrator:current -f Containerfile .

install -m 644 deploy/decom.network deploy/decom-postgres.container deploy/decom-app.container /etc/containers/systemd/
install -m 644 deploy/decom-backup.service deploy/decom-backup.timer /etc/systemd/system/
install -m 755 deploy/decom /usr/local/bin/decom
install -m 755 deploy/restore-test.sh /usr/local/sbin/decom-restore-test
systemctl daemon-reload
systemctl start decom-postgres.service
systemctl restart decom-app.service
systemctl enable --now decom-backup.timer >/dev/null
echo "${version}" > /etc/decom/VERSION

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done
/usr/local/bin/decom health
