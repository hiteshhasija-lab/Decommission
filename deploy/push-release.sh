#!/usr/bin/bash
# From a checkout: copy the committed HEAD to the orchestrator VM and install it there.
#   bash deploy/push-release.sh root@10.0.0.167
set -euo pipefail
target=${1:?usage: push-release.sh root@<orchestrator VM>}
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Commit first: the release is the committed HEAD."; exit 1; }
version=$(node -p "require('./package.json').version")
dir="/opt/decom/releases/${version}-$(git rev-parse --short HEAD)"
git archive --format=tar HEAD | ssh "$target" "mkdir -p '$dir' && tar -x -C '$dir'"
ssh "$target" "bash '$dir/deploy/install.sh'"
