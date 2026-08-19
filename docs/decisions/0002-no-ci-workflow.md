# ADR 0002 — The verification gate runs locally, not in CI

**Status:** Accepted
**Date:** 19 August 2026

## Context

The Master Command's TAB 18 calls for continuous integration on all three repositories,
and TAB 02 for a build → test → scan → deploy pipeline. The project has since run out of
GitHub Actions credit, and the owner set a hard rule: no workflow CI.

## Decision

No GitHub Actions workflow exists in any of the three repositories. `scripts/verify.sh`
runs every gate — typecheck, lint, tests, secret scan, build — and
`scripts/install-hooks.sh` wires it to `pre-commit`.

## Rationale

A gate that cannot be afforded is a gate that does not run, and a workflow file that
never executes is worse than none: it reads as coverage that is not there. Everything in
`verify.sh` needs only Node and Python 3, both already required to work on this
repository, so running it on every commit costs nothing.

The hook is opt-in per clone and `--no-verify` still works. A gate nobody can bypass
under pressure gets deleted rather than fixed.

## Consequences

- **Verification depends on a human running it, or on the hook being installed.** That is
  a real weakness and it is stated rather than papered over: the Master Command's claim
  that CI "turns a good test suite into a guarantee" no longer holds here.
- Nothing is lost technically when credit returns. A workflow becomes one file whose only
  step is `./scripts/verify.sh`.
- TAB 18's acceptance criteria that depend on a runner — required status checks that
  cannot be bypassed, DORA metrics, provider contract verification on every push — cannot
  be met until then, and TAB 18 must record them as blocked rather than complete.
