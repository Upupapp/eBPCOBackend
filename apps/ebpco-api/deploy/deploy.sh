#!/usr/bin/env sh
# Build, migrate, roll out, verify — docs/DEPLOYMENT.md §Deploy as one command.
# Runs ON THE HOST, in /opt/ebpco, after push-source.sh has put the source and
# this directory's files there. Normally invoked BY push-source.sh, not by hand.
#
#   ./deploy.sh <build-label>      e.g. ./deploy.sh 6199992-dirty
#
# The label is what /version will report as `commit`; push-source.sh derives
# it from the developer's checkout because the source on the host is a copy,
# not a clone. It stops at the first failure: a failed migration leaves the
# old container serving; a /ready that never says `ready` leaves the new one
# running for inspection and exits 1. No automatic rollback.
set -eu

cd "$(dirname "$0")"

for f in server.env infra.env Caddyfile docker-compose.yml backend/apps/ebpco-api/Dockerfile; do
  if [ ! -e "$f" ]; then
    echo "missing $f — see deploy/README.md" >&2
    exit 78 # EX_CONFIG, the same code the service uses for a bad environment
  fi
done

BUILD_COMMIT="${1:-unknown}"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export BUILD_COMMIT BUILD_TIME

# The public name Caddy serves and the checks below hit: the second site
# block in the Caddyfile (the first is the real domain, not yet resolving).
API_HOST="$(grep -oE '^[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io' Caddyfile | head -n1)"
: "${API_HOST:?no sslip.io site block found in Caddyfile}"

echo "==> building ${BUILD_COMMIT} (${BUILD_TIME})"
docker compose build ebpco-api migrate

echo "==> migrating"
docker compose run --rm migrate

echo "==> reloading caddy config (no-op if unchanged)"
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

echo "==> rolling out"
docker compose up -d --remove-orphans

echo "==> waiting for https://${API_HOST}/ready"
i=0
until READY_JSON="$(curl -fsS "https://${API_HOST}/ready" 2>/dev/null)"; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "!! /ready did not answer 200 in 60 s. Inspect with:" >&2
    echo "     docker compose logs --tail=100 ebpco-api caddy" >&2
    exit 1
  fi
  sleep 2
done

# 200 is also what `degraded` answers (health.controller.ts): a non-critical
# dependency is down. docs/DEPLOYMENT.md step 3 says that stops the rollout
# for a human decision, so it stops here too.
case "$READY_JSON" in
  *'"status":"ready"'*) ;;
  *)
    echo "!! /ready answered, but not 'ready':" >&2
    echo "   $READY_JSON" >&2
    exit 1
    ;;
esac

echo "==> verifying /version reports ${BUILD_COMMIT}"
VERSION_JSON="$(curl -fsS "https://${API_HOST}/version")"
case "$VERSION_JSON" in
  *"$BUILD_COMMIT"*) ;;
  *)
    echo "!! /version does not mention ${BUILD_COMMIT}:" >&2
    echo "   $VERSION_JSON" >&2
    echo "   A green check on the previous build is the classic false pass." >&2
    exit 1
    ;;
esac

echo "==> deployed ${BUILD_COMMIT}"
echo "    $VERSION_JSON"
