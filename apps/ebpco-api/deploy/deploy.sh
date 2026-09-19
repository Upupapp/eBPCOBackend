#!/usr/bin/env sh
# Build, migrate, roll out, verify — docs/DEPLOYMENT.md §Deploy as one command,
# run ON THE HOST from this directory. Idempotent: a re-run with nothing new
# rebuilds from cache, reports "already current", and restarts nothing.
#
#   ./deploy.sh              # deploy the checked-out commit
#   ./deploy.sh --pull       # git pull first, then the same
#
# It stops at the first failure. In particular: if migrations fail, the old
# container keeps serving and nothing is rolled out (step 1 before step 2,
# which is what makes a bad deploy survivable). If /ready never reports ready,
# the new container is left running for inspection and the script exits 1 —
# it does not roll back on its own (docs/DEPLOYMENT.md, "What is not covered").
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "deploy/.env is missing. Copy .env.example to .env and fill it in." >&2
  exit 78 # EX_CONFIG, the same code the service uses for a bad environment
fi

if [ "${1:-}" = "--pull" ]; then
  git pull --ff-only
fi

# Baked into the image so /version can be checked against what was intended.
BUILD_COMMIT="$(git rev-parse --short HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export BUILD_COMMIT BUILD_TIME

# Read once; the same value Caddy serves on and the check below hits.
API_HOST="$(sed -n 's/^API_HOST=\(.*\)$/\1/p' .env | head -n1)"

echo "==> building ${BUILD_COMMIT} (${BUILD_TIME})"
docker compose build --pull api migrate

echo "==> migrating"
docker compose run --rm migrate

echo "==> rolling out"
docker compose up -d --remove-orphans

echo "==> waiting for https://${API_HOST}/ready"
# 30 × 2 s. Covers a cold start plus, on the very first deploy, Caddy's
# certificate issuance. No -k: a wrong certificate is a failure.
i=0
until READY_JSON="$(curl -fsS "https://${API_HOST}/ready" 2>/dev/null)"; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "!! /ready did not answer 200 in 60 s. Inspect with:" >&2
    echo "     docker compose logs --tail=100 api caddy" >&2
    exit 1
  fi
  sleep 2
done

# 200 is also what `degraded` answers (health.controller.ts): a non-critical
# dependency is down. docs/DEPLOYMENT.md step 3 says that stops the rollout
# for a human decision, so it stops here too — the container is up, but this
# script does not call it deployed.
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
