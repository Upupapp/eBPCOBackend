# eBPCO API

The backend of record for the Electronic Building Permit and Certificate of Occupancy
system. One authoritative service behind two clients: the applicant mobile app (Flutter)
and the LGU web admin (Angular).

> **TAB 02 of the Production Launch Master Command.** This repository is a service
> skeleton: it can be configured, run, observed and verified, and it deliberately
> contains **no domain logic**. Identity arrives in TAB 03, the data model in TAB 04, the
> lifecycle engine in TAB 05.

## Run it

```sh
npm ci
cp .env.example .env      # development only; staging and production set real env vars
npm run start:dev
```

```sh
curl localhost:3000/health    # {"status":"ok"}
curl localhost:3000/ready     # {"status":"ready","checks":[]}
curl localhost:3000/version
```

## Verify it

```sh
./scripts/verify.sh          # typecheck, lint, tests, secret scan, build
./scripts/install-hooks.sh   # …and run that on every commit
```

There is no CI workflow, deliberately — see `docs/decisions/0002-no-ci-workflow.md`.

## Shape

```
src/
  main.ts             process entry; fails loudly on bad config, binds the port
  bootstrap.ts        builds the app without listening, so tests exercise the real wiring
  app.module.ts       composition root
  config/             twelve-factor configuration, validated once at boot
  common/
    correlation/      one id per request, through every log line
    logging/          structured logs that redact personal data and credentials
    problem/          RFC 9457 Problem Details, as the contract defines them
    http/             helmet, rate limiting, timeouts, request logging
  modules/
    health/           /health, /ready, /version
```

Layering is enforced by module boundaries rather than convention: transport may depend on
application services, application services on the domain, the domain on nothing. A
lifecycle rule that ends up in a controller is a rule no unit test can reach without an
HTTP request.

## Things that are load-bearing

- **Configuration has no defaults for backing services.** A default database URL is a
  service that starts successfully while talking to the wrong thing. Boot fails with
  every problem listed at once and exit code `78`.
- **The logger redacts, the reviewer does not.** A log aggregator holding applicant names
  and mobile numbers is a second, unregistered copy of personal data with none of the
  database's access controls. `logger.spec.ts` asserts thirty field names never appear.
- **A 5xx never carries `detail`.** An unexpected exception's message routinely contains
  a query fragment or a row of applicant data. It goes to the log with the correlation
  id; the caller learns only that the request failed.
- **`/ready` starts with no probes** and answers honestly — see
  `docs/decisions/0003-empty-readiness-registry.md`. Four probes reporting `up` against
  services that do not exist would make the first real outage invisible.
- **`/health` touches nothing.** If it checked the database, a database outage would fail
  liveness on every instance, the orchestrator would restart all of them, and a
  recoverable dependency outage would become a total one.

## Documents

| | |
|---|---|
| `docs/ENVIRONMENTS.md` | The three environments and the resource graph hosting must satisfy |
| `docs/DEPLOYMENT.md` | The deploy sequence, as a runbook, since there is no pipeline |
| `docs/decisions/` | Architecture decision records, including E-1 |

The API contract lives in its own repository (`ebpco-contract`) and is the single source
of truth for what this service returns. It is at `0.1.0` and **not yet ratified**.
