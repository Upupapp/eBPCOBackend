#!/usr/bin/env bash
# Everything that must pass before a commit is worth keeping.
#
# There is deliberately no GitHub Actions workflow: the project has no Actions
# credit, and a gate that cannot be afforded is a gate that does not run. This
# script is what a workflow would call, so porting it later is one file rather
# than a rewrite. `scripts/install-hooks.sh` wires it to pre-commit.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── typecheck ────────────────────────────────────────────────────"
npm run --silent typecheck

echo "── lint ─────────────────────────────────────────────────────────"
npm run --silent lint

echo "── tests ────────────────────────────────────────────────────────"
npm run --silent test -- --silent

echo "── reachability ─────────────────────────────────────────────────"
# What the tests structurally cannot check: whether anything but the suite
# reaches this code. Three sweeps found the same defect — built, tested, wired
# to nothing — so it is a gate rather than an exercise.
npm run --silent audit:reachability | tail -3

echo "── secrets ──────────────────────────────────────────────────────"
python3 scripts/scan-secrets.py

echo "── build ────────────────────────────────────────────────────────"
npm run --silent build

echo
echo "ALL GATES PASSED"
