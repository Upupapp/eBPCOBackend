# The API on LGUIDS-SHARED-LINODE

The eBPCO API runs on one Linode — **LGUIDS-SHARED-LINODE**, `139.162.51.165`, Linode 2 GB,
Singapore — as a Docker Compose stack in `/opt/ebpco`. This directory is that stack, versioned:
the compose file, the Caddyfile, templates for the two env files, and the two scripts that
deploy to it. Stood up by hand on 2026-09-17; brought under version control on 2026-09-19.

| | |
|---|---|
| API (HTTPS) | `https://139-162-51-165.sslip.io` — `/health`, `/ready`, `/version` |
| API (plain HTTP, legacy) | `http://139.162.51.165:3000` — see [Port 3000](#port-3000) |
| Admin portal | `https://ebpcowebadmin.netlify.app` |
| Citizen portal | `https://fastidious-chimera-7a7a18.netlify.app` |
| Real domain | `api.castilla-ebpco.online` — registered, **not yet pointed here** |
| Environment | `staging` (MinIO for documents, local signature scanner) |

```
public ── :443 ──► caddy ──► ebpco-api:3000 ──► postgres:5432   (./data/postgres)
                                     └────────► minio:9000      (./data/minio, S3 driver)
```

Files here and where they live on the host (`/opt/ebpco`):

| here | on the host | |
|---|---|---|
| `docker-compose.yml` | `docker-compose.yml` | the stack |
| `Caddyfile` | `Caddyfile` | TLS + reverse proxy; two site blocks |
| `server.env.example` | `server.env` (600, real values) | the API's environment |
| `infra.env.example` | `infra.env` (600, real values) | Postgres / MinIO secrets |
| `deploy.sh` | `deploy.sh` | build → migrate → up → verify, run on the host |
| `push-source.sh` | — | run from a dev machine: sync source + run deploy.sh |
| — | `backend/apps/ebpco-api/` | copy of this app's source (not a git clone) |

## Deploying a change

There is no CI. From a developer machine with SSH access (below):

```sh
apps/ebpco-api/deploy/push-source.sh
```

That tars `Dockerfile`, `package*.json`, `tsconfig*.json`, `src/`, `scripts/`, `db/migrations/`
and this directory to the host, refreshes the stack files at `/opt/ebpco` from it, then runs
`deploy.sh <label>` there, which:

1. `docker compose build ebpco-api migrate` — with `BUILD_COMMIT=<label>` baked in;
2. `docker compose run --rm migrate` — applies pending migrations, prints "already current"
   otherwise; a failure here leaves the old container serving;
3. reloads Caddy, then `docker compose up -d`;
4. polls `https://139-162-51-165.sslip.io/ready` and insists on `"status":"ready"`
   (`degraded` is a 200 too and means a human decides);
5. fetches `/version` and checks it names `<label>` — a green check on the previous build is
   the classic false pass.

`<label>` is the short commit, with `-dirty` appended when the working tree differs from
HEAD. It is what `/version` reports, so a `-dirty` deployment is visible for what it is.

Roll back by checking out the previous commit and running `push-source.sh` again; migrations
are additive, so the previous build runs against the newer schema.

## Access

SSH as `root`. Keys in `/root/.ssh/authorized_keys`; the Linode dashboard's LISH console
(Linodes → LGUIDS-SHARED-LINODE → Launch LISH Console) is the way in when no key works,
and where a new key gets added:

```sh
echo '<public key>' >> ~/.ssh/authorized_keys
```

A convenient `~/.ssh/config` entry on the developer machine, which is what `push-source.sh`
defaults to:

```
Host ebpco-linode
  HostName 139.162.51.165
  User root
  IdentityFile ~/.ssh/ebpco-linode
  IdentitiesOnly yes
```

## Looking around

```sh
ssh ebpco-linode
cd /opt/ebpco
docker compose ps
docker compose logs -f ebpco-api          # structured JSON, one line per event
docker compose logs -f caddy              # certificate issuance lives here
curl -s https://139-162-51-165.sslip.io/ready | jq
docker compose exec postgres psql -U ebpco -d ebpco
```

`MAIL_DRIVER` is unset, so it is `console`: password-reset mail is printed to
`docker compose logs ebpco-api`, not sent.

### Accounts

`paul@lguids.com.ph` is the seeded `super-admin` (2026-09-17). Sign-in for that role needs a
TOTP code as well as the password. If the account is ever lost, re-seed against the stack:

```sh
docker compose run --rm -e EBPCO_SUPERADMIN_PASSWORD='≥ 12 characters' \
  migrate npm run seed:super-admin       # prints the TOTP secret ONCE
```

## Port 3000

`ebpco-api` publishes `0.0.0.0:3000` — plain HTTP, open to the internet. It predates HTTPS
(the first deploy had no name to get a certificate for) and still exists because both
portals' *local dev servers* proxy to it:

- admin: `E-BPCO-Software-main/proxy.conf.json`
- citizen: `ebpco-user-portal/proxy.conf.js`

A staff login through it crosses the internet unencrypted. Point those two configs at
`https://139-162-51-165.sslip.io`, then change the compose line to `"127.0.0.1:3000:3000"` and
`push-source.sh`. Nothing else uses it: the Netlify portals have been on the HTTPS name since
2026-09-19.

## The real domain

`castilla-ebpco.online` is registered but its DNS points at a parking address
(`198.54.117.242`, Namecheap). The Caddyfile already has the `api.castilla-ebpco.online` site
block; Caddy retries certificate issuance for it in the background and will start serving the
moment the A record points at `139.162.51.165` — nothing to deploy. Then, in this order:

1. change `EBPCO_API_BASE_URL` in both portals' `netlify.toml` to `https://api.castilla-ebpco.online`
   and let Netlify rebuild;
2. if the portals themselves move to `admin.`/`citizen.castilla-ebpco.online`, change
   `PORTAL_BASE_URL`/`USER_PORTAL_BASE_URL` in `server.env` (they are the CORS allowlist) and
   `docker compose up -d ebpco-api`;
3. optionally drop the sslip.io block.

## Backups

One host, one disk, no point-in-time recovery. Until there is a managed database:

```sh
docker compose exec -T postgres pg_dump -U ebpco -Fc ebpco > "ebpco-$(date -u +%F).dump"
tar czf "minio-$(date -u +%F).tgz" -C data minio
```

Copy both off the host. Restore with `pg_restore -U ebpco -d ebpco --clean` into a fresh
database. Rehearse it once before you need it.

## Upgrading to production

`EBPCO_ENVIRONMENT=production` refuses to boot (exit 78, naming the variable) until
`MALWARE_SCANNER_DRIVER=clamav`. The S3 requirement is already met by MinIO. So:

1. add a `clamav` service (`clamav/clamav:stable`, volume for `/var/lib/clamav`) to the compose
   file and set `MALWARE_SCANNER_URL=tcp://clamav:3310`. It needs about 1 GB of RAM for its
   signature database — this is a 2 GB Linode *shared with other services*; measure with
   `free -m` first, and expect to resize the Linode;
2. `MAIL_DRIVER=smtp` plus `SMTP_HOST/USER/PASS` and `MAIL_FROM`, or password resets go to
   the logs where no officer sees them;
3. `DOCS_ENABLED` stays `false`;
4. the recorded, revocable approval `docs/DEPLOYMENT.md` §Production requires.

## What this is not

Against `docs/ENVIRONMENTS.md`'s requirements on a provider:

| Requirement | Here |
|---|---|
| Private networking for DB and store | ✅ loopback-only ports; only Caddy's 80/443 and the API's legacy :3000 are public |
| Encryption at rest | ⚠️ only if the Linode's disk is |
| Point-in-time recovery | ❌ `pg_dump` above |
| Secret manager | ❌ `/opt/ebpco/*.env` on disk, mode 600 |
| Two availability zones | ❌ one host, shared with unrelated services |
| Data residency in the Philippines | ❌ Singapore — the nearest region; a fact for the NPC filing |

Each ❌ is a reason this runs `staging` and a line item for E-1's hosting half.
