#!/usr/bin/env sh
# Ship this checkout's API source to the host and deploy it. Run from a
# developer machine, from anywhere inside the repository:
#
#   apps/ebpco-api/deploy/push-source.sh              # host alias "ebpco-linode"
#   apps/ebpco-api/deploy/push-source.sh root@1.2.3.4
#
# Needs: ssh access to the host as a user who can run docker (see README §Access),
# git, tar. There is no CI (docs/decisions/0002-no-ci-workflow.md), so this is
# the pipeline: what a developer has checked out is what gets built there.
#
# What it sends — only what the Dockerfile COPYs, plus this directory:
#   Dockerfile package.json package-lock.json tsconfig.json tsconfig.build.json
#   src/ scripts/ db/migrations/ deploy/
# What it never sends: node_modules, dist, .env*, test/, *.spec.ts, .data.
# The host's server.env / infra.env are never touched; only the *.example
# templates travel, for diffing against them.
#
# The build label is `git describe`-style: short commit, plus `-dirty` when the
# working tree differs from HEAD — which is honest about what was actually
# deployed and is what /version will show.
set -eu

HOST="${1:-ebpco-linode}"
REMOTE_DIR=/opt/ebpco

REPO_ROOT="$(git rev-parse --show-toplevel)"
API_DIR="$REPO_ROOT/apps/ebpco-api"
cd "$API_DIR"

LABEL="$(git rev-parse --short HEAD)"
if ! git diff --quiet HEAD -- . ; then LABEL="${LABEL}-dirty"; fi

echo "==> syncing apps/ebpco-api to ${HOST}:${REMOTE_DIR}/backend (label ${LABEL})"
tar -cf - \
    --exclude='*.spec.ts' --exclude='*.e2e-spec.ts' \
    Dockerfile package.json package-lock.json tsconfig.json tsconfig.build.json \
    src scripts db/migrations deploy \
  | ssh "$HOST" "set -e
      mkdir -p ${REMOTE_DIR}/backend/apps/ebpco-api
      cd ${REMOTE_DIR}/backend/apps/ebpco-api
      rm -rf src scripts db/migrations deploy
      tar -xf -
      # The stack's own files live at the top of ${REMOTE_DIR}; refresh them
      # from the copy that just arrived so repo and host cannot drift.
      cp deploy/docker-compose.yml deploy/Caddyfile deploy/deploy.sh ${REMOTE_DIR}/
      cp deploy/server.env.example deploy/infra.env.example ${REMOTE_DIR}/
      chmod +x ${REMOTE_DIR}/deploy.sh
      echo '    synced' \$(find src -type f | wc -l) 'src files,' \$(ls db/migrations | wc -l) 'migrations'"

echo "==> deploying on ${HOST}"
ssh "$HOST" "cd ${REMOTE_DIR} && ./deploy.sh ${LABEL}"
