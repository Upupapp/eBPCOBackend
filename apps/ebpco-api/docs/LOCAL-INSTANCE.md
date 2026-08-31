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

## Standing it up

```sh
# 1. A database. Port 5433 — 5432 may already be taken on a shared machine,
#    and running 31 migrations into someone else's database is destructive.
PGDATA_DIR=/tmp/ebpco-pg node serve.mjs      # see the note on PGDATA_DIR below

# 2. Schema
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres npm run migrate

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

**Then you will hit D-9 below**: a self-registered account cannot file, because
nothing creates its applicant profile. Until that is fixed, seed one:

```sql
insert into applicants (id, account_id, first_name, last_name)
select gen_random_uuid(), id, 'A', 'B' from accounts where email_normalised = 'a@example.ph';
```

After that a filing works:

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
