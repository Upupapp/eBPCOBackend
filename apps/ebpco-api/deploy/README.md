# Deploying the API to one Linux host

Docker Compose on a single Linode: Caddy terminates TLS and proxies to the API, the API
talks to Postgres on a private network. This is `docs/DEPLOYMENT.md`'s runbook made
runnable, and `docs/ENVIRONMENTS.md`'s resource graph collapsed onto one box. It is the
first real environment; it is not the production graph (no PITR, one zone, no secret
manager — see [What this is not](#what-this-is-not) before pointing citizens at it).

Files in this directory:

| | |
|---|---|
| `docker-compose.yml` | the stack: `postgres`, `api`, `caddy`; `clamav` behind the `production` profile; `migrate` as a one-off |
| `Caddyfile` | one site block, TLS from Let's Encrypt, proxy to `api:3000` |
| `.env.example` | every variable the deployment needs, with the ones to change marked |
| `deploy.sh` | build → migrate → roll out → verify `/ready` and `/version` |
| `docker-compose.host-caddy.yml` | override for a host whose own Caddy/nginx already owns 80/443 |

## 0. What you need

- A Linode (or any Ubuntu 22.04+/Debian 12 host) with **2 GB RAM** or more. 1 GB runs
  `api + postgres + caddy`; it does not run ClamAV alongside them.
- A **hostname** for the API. Caddy cannot issue a certificate for a bare IP, and the
  portals are served over HTTPS, so an HTTP API would be blocked by the browser as mixed
  content. Either:
  - a real one, e.g. `api.ebpco.castilla.gov.ph`, with an **A record** at the host's IP; or
  - **no DNS at all**: `<ip-with-dashes>.sslip.io` — for a Linode at `172.105.1.2` that is
    `172-105-1-2.sslip.io`. sslip.io is a public wildcard DNS that answers with the IP in
    the name, and Let's Encrypt issues certificates for it. Adequate for staging; a real
    hostname is a one-line change in `.env` and both portals' `netlify.toml` later.
- The two portals' deployed origins, already in `.env.example`:
  `https://ebpcowebadmin.netlify.app` (admin) and
  `https://fastidious-chimera-7a7a18.netlify.app` (citizen).
- SSH access as a user who can `sudo`.

## 1. Prepare the host (once)

```sh
# Firewall: SSH, HTTP (for the ACME challenge and the redirect to HTTPS), HTTPS.
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw --force enable

# Docker Engine + Compose plugin, from Docker's own repository (the distro's is old).
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker                      # or log out and back in
docker compose version             # must print v2.x
```

If the Linode is behind Linode's Cloud Firewall as well, open the same three ports there.

**Check nothing already owns ports 80/443.** On `139.162.51.165` (2026-09-19) a Caddy was
already answering — `curl -sI http://139.162.51.165/` returned `Server: Caddy`. The stack
brings its own, and two cannot bind the same port. Pick one:

- **Replace it** — if that Caddy is serving nothing you need:
  `sudo systemctl disable --now caddy`. The stack's Caddy takes over 80/443 in step 3.
- **Keep it** — if it already serves another site on this host. Use the override in
  [`docker-compose.host-caddy.yml`](docker-compose.host-caddy.yml): it drops the stack's
  Caddy, publishes the API on loopback only, and the host's Caddy gets one more site block
  (the file's header has it). Export `COMPOSE_FILE` as the header says **before** step 3,
  and `deploy.sh` uses both files from then on.

`sudo ss -ltnp 'sport = :443'` names the process if it is not Caddy.

## 2. Get the code and configure

```sh
git clone https://github.com/Upupapp/eBPCOBackend.git
cd eBPCOBackend/apps/ebpco-api/deploy
cp .env.example .env
chmod 600 .env
```

Now edit `.env`. Every line marked `# CHANGE:` needs a value:

```sh
# Five random values — run this five times, one per secret. Each must differ.
openssl rand -base64 48
```

- `API_HOST` — the hostname from step 0, no scheme.
- `POSTGRES_PASSWORD` — one random value.
- `JWT_SIGNING_KEY`, `PASSWORD_PEPPER`, `TOTP_ENCRYPTION_KEY`, `PUSH_TOKEN_ENCRYPTION_KEY`
  — four more, all different. **Back these up somewhere that is not this host**: losing
  `TOTP_ENCRYPTION_KEY` locks out every officer who has enrolled a second factor;
  losing `PASSWORD_PEPPER` invalidates every password.
- `PORTAL_BASE_URL` / `USER_PORTAL_BASE_URL` are pre-filled with the two Netlify origins.
  They are the CORS allowlist: if a portal ever moves, change it here too, or that portal
  fails every request with a CORS error in the browser console and nothing in the API's logs.

Leave `EBPCO_ENVIRONMENT=staging` for now. See [Upgrading to production](#upgrading-to-production).

## 3. First deploy

```sh
./deploy.sh
```

Roughly two minutes the first time: `npm ci`, the TypeScript build, Postgres
initialising, migrations, then Caddy fetching a certificate. The script ends with the
`/version` document naming the commit it just built, or exits non-zero at the first step
that did not go as it should. Nothing after a failed step runs — in particular the old
container keeps serving if a migration fails.

What just happened, in order (this is `docs/DEPLOYMENT.md` §Deploy):

1. `docker compose build` — the `runtime` image for the API and the `migrate` image
   (same Dockerfile, the one stage allowed to keep `ts-node` and `scripts/`).
2. `docker compose run --rm migrate` — applies pending migrations against the compose
   network's Postgres and exits. It prints the host and database it is about to touch
   before it touches anything.
3. `docker compose up -d` — Postgres (if not already), the API, Caddy.
4. Polls `https://$API_HOST/ready` until it answers, then insists on `"status":"ready"`
   — `degraded` is a 200 too, and means a human decides.
5. Fetches `/version` and checks the commit in it is the commit that was built.

## 4. The first account

There is no route to the first staff account, by design (see `scripts/seed-super-admin.ts`).
Create it once, against the database inside the stack:

```sh
docker compose run --rm -e EBPCO_SUPERADMIN_PASSWORD='choose ≥ 12 characters' \
  migrate npm run seed:super-admin
```

It creates `paul@lguids.com.ph` as `super-admin`, enrols a second factor, and **prints
the TOTP secret once**. Add it to an authenticator app now — it is not shown again, and a
super-admin cannot sign in without a code. Re-running the seed is safe: an account that
already exists is left alone.

Then sign in at `https://ebpcowebadmin.netlify.app/login` with that address, the
password you chose, and the current code. If the login page shows **"The request
failed"**, the portal is not pointed at this API yet — see [The portals](#the-portals).
If the browser console shows a **CORS** error, `PORTAL_BASE_URL` in `.env` does not match
the portal's real origin.

## 5. Every deploy after that

```sh
cd eBPCOBackend/apps/ebpco-api/deploy
./deploy.sh --pull
```

Same five steps. Roll back by checking out the previous commit and running
`./deploy.sh` again; migrations are additive, so the previous build runs against the
newer schema (`docs/DEPLOYMENT.md` step 5).

## The portals

The API's origin has to be told to the two Netlify sites, or they keep posting logins to
themselves and getting a 404 HTML page back — that is what "The request failed" on the
login page was. Both sites read `EBPCO_API_BASE_URL` at build time from
`[build.environment]` in their `netlify.toml`, so the value is in the repository and a
redeploy picks it up:

- admin portal — `eBPCO-Web/netlify.toml`
- citizen portal — `eBPCO-Information-Portal-Website/netlify.toml`

Set it to `https://$API_HOST` (no trailing slash) in each, push, and let Netlify build.

## Looking around

```sh
docker compose ps                          # what is running
docker compose logs -f api                 # structured JSON, one line per event
docker compose logs -f caddy               # certificate issuance lives here
curl -s https://$API_HOST/ready | jq       # per-dependency status
docker compose exec postgres psql -U ebpco # a shell in the database
```

Password-reset emails are printed to `docker compose logs api` while `MAIL_DRIVER=console`.

## Backups

The compose stack gives you one host and one disk. Until there is a managed database
with point-in-time recovery, take a dump daily and copy it off the host:

```sh
docker compose exec -T postgres pg_dump -U ebpco -Fc ebpco > "ebpco-$(date -u +%F).dump"
```

Restore with `pg_restore -U ebpco -d ebpco --clean` into a fresh database. Rehearse it
once before you need it. Documents (`OBJECT_STORE_DRIVER=filesystem`) live in the
`documents` volume — `docker run --rm -v ebpco_documents:/d -v "$PWD":/out alpine tar czf
/out/documents.tgz -C /d .` copies them out — until the store is S3.

## Upgrading to production

`EBPCO_ENVIRONMENT=production` refuses to boot (exit 78, naming the variable) until:

1. **Object store is S3.** Create a Linode Object Storage bucket (nearest region is
   `ap-south-1`, Singapore — a data-residency fact the NPC filing must state), keep it
   private, and set in `.env`:
   ```
   OBJECT_STORE_DRIVER=s3
   OBJECT_STORE_ENDPOINT=https://ap-south-1.linodeobjects.com
   OBJECT_STORE_BUCKET=<bucket>
   OBJECT_STORE_REGION=ap-south-1
   OBJECT_STORE_PUBLIC_PROBE_URL=https://ap-south-1.linodeobjects.com/<bucket>
   AWS_ACCESS_KEY_ID=<key>
   AWS_SECRET_ACCESS_KEY=<secret>
   ```
   The readiness probe makes an anonymous read against the probe URL and takes the
   instance **out of rotation if it succeeds** — a public bucket of identity documents is
   treated as an outage.
2. **Scanner is ClamAV.** `MALWARE_SCANNER_DRIVER=clamav` and start the stack with the
   profile from now on: `docker compose --profile production up -d`. Needs the 2 GB host.
   The first start downloads signatures (a few minutes); until then `/ready` reports
   `degraded` and uploads are held, not lost.
3. **Real mail.** `MAIL_DRIVER=smtp` plus `SMTP_HOST/USER/PASS` and `MAIL_FROM`, or
   password resets go to the logs where no officer will see them.
4. `DOCS_ENABLED` stays `false` — production rejects `true` at boot.

And the recorded, revocable approval from a named person that `docs/DEPLOYMENT.md`
§Production requires. Then `./deploy.sh`.

## What this is not

Measured against `docs/ENVIRONMENTS.md`'s requirements on a provider:

| Requirement | Here |
|---|---|
| Private networking for DB and store | ✅ neither is published; only Caddy's 80/443 are |
| Encryption at rest | ⚠️ only if the Linode's disk is — enable at provisioning |
| Point-in-time recovery | ❌ daily `pg_dump` above; PITR needs a managed database |
| Secret manager | ❌ `deploy/.env` on disk, mode 600 |
| Two availability zones | ❌ one host; a documented, accepted single-zone risk |
| Data residency in the Philippines | depends on the Linode region chosen — Singapore is the nearest; none is in-country |

Each ❌ is a reason this runs `staging` today and a line item for E-1's hosting half.
