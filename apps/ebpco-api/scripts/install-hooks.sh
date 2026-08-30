#!/usr/bin/env bash
# Install the local pre-commit gate.
#
# With no CI runner available this hook is the only thing standing between an
# unverified change and a commit. Opt-in per clone, and --no-verify still
# works: a gate nobody can bypass under pressure gets deleted rather than fixed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"

cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "running verification gate (bypass with --no-verify)…"
exec "$(git rev-parse --show-toplevel)/scripts/verify.sh"
HOOKEOF

chmod +x "$HOOK"
echo "installed $HOOK"
