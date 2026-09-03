# Running one reachable instance

For a client developer who needs a server to point at. Not staging, not
production, not a hosting decision — a process on `localhost:3000`.

## What it needs

Exactly what `.env.example` says, with **one change**:

```
DB_POOL_MAX=1
```

The rest of the development defaults are fine. `OBJECT_STORE_DRIVER=filesystem`
and `MALWARE_SCANNER_DRIVER=local` mean **no MinIO and no ClamAV** for local
work. Production still refuses to boot on either, which is deliberate and
unchanged.

## Why `DB_POOL_MAX=1`

Only if you are backing this with **PGlite** rather than a real PostgreSQL.
There is no `postgres` binary on the build Mac, so the practical local database
is a PGlite socket server — and it serves **one connection at a time**. With the
default pool of 10, the first filing dies with:

```
read ECONNRESET
  at SqlCalendarRepository.load        (Promise.all, two concurrent queries)
  at ApplicantQueryService.byId
  at ApplicantWriteController.submit
```

The application is written, the read-back fails, and the client sees a 500 on a
filing that partly succeeded. That is a property of the stand-in database, not
of this service: against real PostgreSQL, `DB_POOL_MAX=10` is correct.

### Measured, because "the bridge cannot do fan-out" is the wrong conclusion

The same two queries `SqlCalendarRepository.load` issues, run against the same
socket bridge in one process, changing nothing but the pool size:

```
DB_POOL_MAX=1  ->  OK, both queries returned
DB_POOL_MAX=4  ->  read ECONNRESET
```

So this is **a pool setting, not a limit on what the bridge can serve**. At
`max: 1` the pool queues the second query onto the one connection it holds; above
1 it opens a second connection for the second half of the `Promise.all`, and the
bridge drops it — which is why the stack trace names `index 1`. Every request
path in this service works over the bridge at `max: 1`, filing included: all
nineteen permit types were filed through it end to end.

### One consequence worth knowing

The bridge serves **one connection at a time, in total** — not one per client. So
while the API is running it holds that connection, and a second process cannot
query the database at all:

```sh
# with the API up, any out-of-band query fails:
npx ts-node --transpile-only some-query.ts   # -> read ECONNRESET
```

Stop the API first, or read through the API's own endpoints. This is also the
cheapest confirmation that the bridge is behaving as described rather than
something being wrong with your setup.

## Standing it up

Put `DATABASE_URL` in your own `.env` — never in a tracked file. The secret
scanner refuses a connection string carrying a password anywhere in the
repository, which is why this page does not print one.

```sh
# 1. A database. Port 5433 — 5432 may already be taken on a shared machine,
#    and running 31 migrations into someone else's database is destructive.
PGDATA_DIR=/tmp/ebpco-pg node tool/pg-bridge.mjs   # tracked; see PGDATA_DIR below

# 2. Schema. DATABASE_URL comes from your .env, pointing at localhost:5433 —
#    which is what .env.example now says. It said 5432 until 3 September, so a
#    copied .env could not reach the bridge; check yours if it predates that.
#    `migrate` prints the host, port and database it is about to touch.
npm run migrate

# 3. The service
npm run start:dev
```

**`PGDATA_DIR` is not optional.** Without it PGlite opens an empty in-memory
database that looks exactly like total data loss on the next restart.

Check it came up:

```sh
curl -s localhost:3000/ready
# {"status":"ready","checks":[{"name":"database","status":"up"}, ...]}
```

## Filing something, end to end

Registration takes more than an address:

```sh
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"firstName":"A","lastName":"B","email":"a@example.ph",
       "mobileNumber":"09171234567","password":"a-long-enough-passphrase"}'
# 202
```

Signing in needs `grantType`:

```sh
curl -X POST localhost:3000/auth/token -H 'content-type: application/json' \
  -d '{"grantType":"password","email":"a@example.ph","password":"a-long-enough-passphrase"}'
```

That account can file immediately. **D-9 is fixed** (`dc10ce8`): registration
writes the applicant profile in the same transaction as the account. This page
used to print a hand-written `insert into applicants` here as a workaround, and
kept printing it for days after the defect was closed — a runbook goes stale
silently, because nothing fails when prose is wrong.

A filing works straight away:

```sh
curl -X POST localhost:3000/applications \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -d '{"permitType":"New Construction","applicationAction":"New",
       "location":"Purok 3, Cumadcad","form":{"ownerName":"Ana Cruz","floorArea":120}}'
# 201, with a referenceNumber
```

## Things a client will get wrong, measured against a running server

**`serviceDomain` is OUTPUT, not input.** `submissionShape` is `.strict()` and
does not declare it. Sending it returns:

```
400 {"errors":[{"pointer":"/","message":"Unrecognized key(s) in object: 'serviceDomain'"}]}
```

The 201 response *contains* `"serviceDomain":"Construction Permit"`, derived from
`permitType`. A client that adds it to the request breaks every filing.

**`Idempotency-Key` is required**, on every write. Omitting it is a 400, not a
default. Replaying the same key returns the same `referenceNumber` and creates
nothing new — which is what makes an offline queue safe to replay.

**`GET /applications/{id}` exists and returns the full record**, including
`form`. It is not the list payload.

**`businessId` is `uuid().nullable()`.** An empty string is a 400; the absence of
a business is `null` or the key omitted.

## Two operations worth knowing about

**`DELETE /me` is account deletion** — the RA 10173 §16(e) right to erasure. 202,
returning `acceptedAt`, `erasedCategories` and `retainedCategories`. It is not
204 on purpose: the response names what survives, because erasure is conditional
on an overriding legal obligation and naming it is what makes the retention
lawful. **This satisfies Apple Guideline 5.1.1(v) today.**

**`POST /applications/{id}/documents/{documentId}/resubmit` does not exist** —
404. See D-8.

## The first staff account

There is no path through the API to it, deliberately: `POST /staff/users` and
`/staff/access-requests/:id/approve` both require `staff:administer`, only
`administrator` and `super-admin` hold it, and every public route mints an
applicant or a row somebody else must act on. A service that could bootstrap its
own administrator over HTTP would be one anyone could.

**Stop the API first.** The bridge serves ONE CONNECTION AT A TIME, in total —
not one per client — so while the service is running it holds the only one and
the seed dies with `read ECONNRESET` at `postgres-client.ts`. This is the first
thing every new instance has to run, so it is the sequence most likely to be
hit before anything else works:

```sh
# API down  ->  seed  ->  API up
#   (stop `npm run start:dev`)
EBPCO_SUPERADMIN_PASSWORD='…' npm run seed:super-admin
npm run start:dev
```

It refuses to run without one and refuses anything under 12 characters. It never
invents a default: a seeded default is a known credential on every deployment
that ever ran the script. Rerunning it changes nothing.

**Keep the `otpauth://` URI it prints.** `super-admin` requires MFA and the seed
enrols it, because an MFA-required account with no enrolled secret can never
sign in — see D-10. The URI is shown once.

**Wait for the next 30-second window before your first sign-in.** Activation
stamps `totp_last_step` and sign-in refuses that step or earlier, so the code
that enrolled is already spent. Used too early you get
"Those credentials were not accepted", which reads like a wrong password.

**Note if you are backing this with PGlite:** it serves ONE connection, so the
seed cannot run while the API is up. Stop the service, seed, start it again.
Against real PostgreSQL this does not arise.
