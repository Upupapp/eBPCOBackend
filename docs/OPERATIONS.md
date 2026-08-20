# Running this service

What an operator has to set, what the process promises in return, and — the
part that matters most — **what has not been verified and cannot be from a
developer machine**.

Nothing here is aspirational. Every behaviour described is enforced by a test in
this repository, except where it says otherwise, and where it says otherwise it
says so plainly.

---

## 1. Configuration

Every value comes from the environment and from nowhere else. There is **no
default for any backing service**: the process refuses to start rather than boot
half-configured, and exits `78` (`EX_CONFIG`) with the missing name on stderr in
plain text — an operator reading a crash loop should not have to parse JSON to
find out what is missing.

### Required

| Variable | Notes |
|---|---|
| `EBPCO_ENVIRONMENT` | `development` \| `staging` \| `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET` | Document storage |
| `MALWARE_SCANNER_URL` | See §5 — the shipped scanner is a stand-in |
| `JWT_SIGNING_KEY` | ≥32 characters |
| `PASSWORD_PEPPER` | ≥32 characters. **Rotating it invalidates every password.** |

### Operational, with defaults

| Variable | Default | What it costs to get wrong |
|---|---|---|
| `PORT` | `3000` | — |
| `DB_POOL_MAX` | `10` | **Per process.** Too high and the replicas together exhaust the server's global connection limit, taking down every other client of the same database — including whatever an operator is using to diagnose it. Multiply by the replica count and compare against `max_connections` before raising it. |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Too high and requests queue behind an unavailable database, turning a fast failure into a timeout for every caller at once. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Enforced by the server, so it applies even if this process stops waiting. |
| `SHUTDOWN_DRAIN_MS` | `12000` | **Must exceed the load balancer's health-check interval times its failure threshold.** Below that the balancer never notices the instance went unready, and every request it routes during the gap is a 502 an applicant sees. |
| `SHUTDOWN_DEADLINE_MS` | `20000` | **Must stay below the orchestrator's termination grace period**, or the process is SIGKILLed mid-transaction and the deadline never fires. Kubernetes' default `terminationGracePeriodSeconds` is 30, and `12 + 20 = 32` exceeds it — raise the grace period or lower these. |
| `BODY_LIMIT_BYTES` | `1048576` | An unbounded body is a denial-of-service surface. |
| `RATE_LIMIT_MAX` | `300` | — |
| `SCHEDULER_ENABLED` | `false` | Off by default. See §4a. |
| `SCHEDULER_TICK_SECONDS` | `15` | Must stay well below the shortest job interval, or a job due every minute waits for the next tick. |
| `DOCUMENT_RETENTION_DAYS` | *(unset)* | The LGU's number (M-15). Unset means retention runs and deletes nothing. |
| `TRUST_PROXY` | `false` | **Set it only behind a proxy you control.** Trusting `X-Forwarded-For` from the open internet lets any caller spoof their address, which defeats rate limiting and poisons the audit trail. |

---

## 2. Migrations run in the pipeline, not on boot

The service does **not** migrate on start. N replicas racing to alter the same
schema is a rollback that has to guess what was applied.

What it does instead is refuse to report ready when the schema is not one it
understands. Three states, and they are not the same:

- **Behind** — migrations this build expects have not been applied. **503.** The
  code expects tables that are not there, and every request touching them fails
  with an error that looks like an application bug.
- **Divergent** — a migration was applied from *different content* than this
  build carries. **503**, and the message says that running them again will not
  fix it, because the instinct on seeing a schema complaint is to run the
  migrations. This is the case a count-based check cannot see, and editing a
  migration after it has run is a thing people do.
- **Ahead** — the database has migrations this build does not know about.
  **200, and logged at warn.** This is deliberate and is the decision most worth
  arguing about: it is the normal state of every rolling deploy that migrates
  before it rolls, and of every rollback. A build that refused whenever the
  schema was newer than itself would take the service down at exactly the moment
  someone was recovering it.

  **This is only safe because migrations are expand-then-contract**: a release
  adds, and a later release removes once nothing reads the old shape. If that
  discipline is broken, this behaviour becomes wrong.

Deploy order: **migrate, then roll.**

---

## 3. Shutdown

On `SIGTERM` or `SIGINT`:

1. **Report not ready** — `/ready` answers 503 immediately.
2. **Keep serving for `SHUTDOWN_DRAIN_MS`** so the balancer has time to act on
   it. Reporting unready and then closing tells the balancer something it has no
   time to use.
3. **Close**, waiting up to `SHUTDOWN_DEADLINE_MS` for in-flight work.
4. **Exit**, with a code that says what happened: `0` clean, `75` the deadline
   fired with work still in flight, `70` closing itself failed.

The distinct codes exist so a crash loop can be diagnosed from logs alone. A
shutdown that failed to close the pool but exited `0` is how a broken shutdown
goes unnoticed for months.

---

## 4. The three probes

| Path | Purpose | Fails when |
|---|---|---|
| `/health` | Liveness. **Touches nothing.** | Never, short of the process being wedged |
| `/ready` | Rotation | Database down, schema behind or divergent, or draining |
| `/version` | Build identity | — |

Liveness deliberately does not check the database. If it did, a database outage
would fail every instance's liveness, the orchestrator would restart all of
them, and a recoverable dependency outage would become a total one.

`/ready` answers 503 with the same body it answers 200 with — the one deliberate
exception to the contract's `problem+json` rule, because the only question the
consumer asks is *which* dependency is down, and a Problem Details document
cannot say. It names dependencies and never their hostnames, versions or
connection strings.

**Critical vs not:** the database and the object store are critical — without
either, every request fails. The malware scanner is **not**. Taking an instance
out of rotation because the scanner is down converts a partial outage (uploads
held unscanned) into a total one.

---

## 4a. Scheduled work

Every replica runs a scheduler; they coordinate through the database. A job is
claimed by one UPDATE whose WHERE only matches an unheld lock, so exactly one
replica runs it — no leader election, no coordinator to be down.

**Off by default.** Set `SCHEDULER_ENABLED=true` on deployments that should run
jobs. A one-off process or a test should not start deleting documents as a side
effect of booting.

| Job | Interval | What it does |
|---|---|---|
| `document-retention` | hourly | Deletes documents whose application closed longer ago than `DOCUMENT_RETENTION_DAYS`. **Unset means it deletes nothing and says so** — the period is the LGU's (M-15), and one invented here would be a data-minimisation decision made by the wrong party. |
| `audit-chain-verification` | daily | Reads every audit row and checks every link. Fails loudly on a break; does **not** take the instance out of rotation, because the evidence is historical and refusing traffic would not protect it. What it needs is a person. |
| `notification-dispatch` | every minute | Plans delivery and **queues** attempts. **Nothing is sent** — push, email and SMS all need a provider that has not been chosen. The detail line says `NOT SENT` on every run so this cannot be mistaken for working. |
| `operational-data-purge` | daily | Idempotency keys past 48h, expired or consumed refresh tokens, used password-reset tickets. |

**Every job must be safe to run twice.** The lease expires so a SIGKILLed
replica does not hold a job for ever, and an expiry cannot tell a dead replica
from a slow one — so a job that overruns its lease will be joined by another.

**The schedule lives in the database.** Changing how often retention runs, or
switching a job off, is an UPDATE to `scheduled_jobs` rather than a deploy.

**"Did it run?"** — `select name, last_finished_at, last_outcome,
consecutive_failures from scheduled_jobs`. That is half the reason it is a
table rather than an advisory lock. `consecutive_failures` is the number to
alert on: one failure is noise, nine is an outage nobody has noticed.

---

## 5. NOT verified, and not verifiable from a developer machine

This is the section to read before a pilot.

- **Nothing here has run against a real PostgreSQL server.** Every persistence
  test uses PGlite — real PostgreSQL compiled to WebAssembly, so the query
  planner, the constraints and the triggers are real — but it is **not a
  pool**. Connection acquisition under contention, `max` exhaustion, server-side
  `statement_timeout` actually firing, TLS, failover and replica lag are all
  unexercised. The pooled adapter's own behaviour (release on error, error
  preservation, idempotent close) is tested against a fake pool; that is a
  different and much smaller claim.
- **No load test.** `DB_POOL_MAX`, `RATE_LIMIT_MAX` and both shutdown timings
  are reasoned defaults, not measured ones.
- **The shutdown sequence has never run under an orchestrator.** The ordering,
  the deadline and the exit codes are tested as a function; whether
  `SHUTDOWN_DRAIN_MS` actually exceeds the balancer's detection window depends
  on a balancer nobody has configured yet.
- **The malware scanner is a local signature stand-in.** Replace it with ClamAV
  or an ICAP service before any real upload (ADR 0009).
- **The object store is a filesystem adapter.** Deploying it means documents
  living on one replica's disk, which is wrong the moment there are two
  replicas (ADR referenced in `documents.module.ts`).
- **No backup or restore procedure has been written or rehearsed.** An untested
  restore is not a backup.
- **Nothing alerts on `consecutive_failures`.** The number is recorded and
  nothing watches it, so a job that has been failing for a week looks exactly
  like one that has been working.
- **No notification is ever sent.** The dispatch job plans and queues; no
  provider exists. An applicant is told nothing by any channel.
- **No log aggregation, metrics or alerting.** The service emits structured JSON
  with correlation ids; nothing collects it.
- **Hosting is undecided** (E-1/E-2, M-27). Everything above assumes a
  container, a reverse proxy and a managed PostgreSQL, and none of that is
  chosen.
