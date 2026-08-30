# Deployment

**There is no CI pipeline.** The project has no GitHub Actions credit — see
`docs/decisions/0002-no-ci-workflow.md`. What follows is the same sequence a pipeline
would run, written as a runbook so it is at least repeatable by hand, and so porting it
to a workflow later is transcription rather than design.

Nothing here has been executed against a real environment. No environment exists yet.

## Before anything is committed

```sh
./scripts/verify.sh
```

Typecheck → lint → tests → secret scan → build. Install it as a hook once and stop
thinking about it:

```sh
./scripts/install-hooks.sh
```

## Build

```sh
docker build \
  --build-arg BUILD_COMMIT="$(git rev-parse --short HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t ebpco-api:"$(git rev-parse --short HEAD)" .
```

The image is multi-stage, runs as `node` (uid 1000), installs with `npm ci
--ignore-scripts`, and prunes dev dependencies before the runtime layer. It is expected
to run with a **read-only root filesystem** and no writable volume: this service persists
nothing locally.

The base image is pinned to a minor version. **Pin the digest at the first real build** —
a fabricated digest would look like supply-chain rigour while providing none.

## Deploy

Ordered, because the order is what makes a bad deploy survivable.

1. **Migrate first, and only additively.** Expand → migrate → contract. A migration that
   drops or renames a column in the same release as the code that stops using it cannot
   be rolled back. TAB 04 owns this.
2. **Roll out to one replica.** Watch `/ready` and the error rate.
3. **Continue only if `/ready` reports `ready`.** A `degraded` reading means a
   non-critical dependency is down and the rollout should stop for a human decision.
4. **Smoke test** `/health`, `/ready`, `/version` — and confirm `/version` reports the
   commit that was just deployed. A green health check on the previous build is the
   classic false pass.
5. **Roll back automatically** if health checks fail: redeploy the previous image tag.
   Because migrations are additive, the previous image still runs against the new schema.

## Production

Requires an explicit, recorded, revocable approval from a named person. Not a
convention — the approval is the evidence that someone accountable decided to expose real
applicant data to a new build.

## What is not covered yet

| Gap | Owner |
|---|---|
| No environment exists; nothing has been deployed | E-1 hosting half |
| No IaC — see `docs/ENVIRONMENTS.md` for the graph it must implement | E-1 hosting half |
| No container or dependency scanning in the loop | TAB 14 |
| No automated rollback — step 5 is manual | TAB 15 + a runner |
| No alerting, so a failed deploy is noticed by a human | TAB 15 |
