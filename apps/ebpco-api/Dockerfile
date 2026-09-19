# syntax=docker/dockerfile:1.7

# BUILD CONTEXT IS THIS DIRECTORY, NOT THE REPOSITORY ROOT.
#
#   docker build -f apps/ebpco-api/Dockerfile apps/ebpco-api
#
# Every COPY below is relative to that. Since the monorepo move on 2026-08-30
# this repository holds more than one service, and building from the root would
# resolve `COPY package.json` to a file that is not this service's -- or to
# nothing at all. Stated here because the failure is a confusing one: the build
# succeeds against the wrong tree, or fails on a path that plainly exists.

# ─────────────────────────────────────────────────────────────── build ──
# Pinned to a specific minor. The digest is pinned at the first real build,
# when a registry is reachable and the digest can be read rather than guessed;
# a fabricated digest here would look like supply-chain rigour while providing
# none. TAB 14 makes digest pinning a required check.
FROM node:22.20-bookworm-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
# `npm ci` and not `npm install`: the lockfile is the input, and a build that
# can silently resolve a different tree is a build that is not reproducible.
# --ignore-scripts because a postinstall script in any transitive dependency
# would run with the build's privileges.
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────────────────────── migrate ──
# `docker build --target migrate -f Dockerfile .`, run as
# `docker run --rm --env-file <prod env> <image> ` (CMD already applies
# migrations and exits — see scripts/migrate.ts's own doc comment on why this
# is deliberately a separate step, run once from the deployment pipeline
# BEFORE the new `runtime` image below rolls out, and not something any
# replica does on its own boot).
#
# Forked from `build` BEFORE the prune two stages down, on purpose: `migrate`
# runs under `ts-node`, a dev dependency, and this is the one image allowed to
# still have it. The `runtime` image below must not — carrying the whole
# TypeScript toolchain into the thing that serves citizen traffic is exactly
# the enlarged attack surface the prune step exists to avoid, so pruning
# happens on a separate branch (`pruned`, next) that `runtime` copies
# `node_modules` from instead.
FROM build AS migrate
COPY scripts ./scripts
COPY db/migrations ./db/migrations
CMD ["npm", "run", "migrate"]

# ──────────────────────────────────────────────────────────────  pruned ──
# Drop dev dependencies from what `runtime` copies forward. Split out of
# `build` itself so `migrate` above can fork from the pre-prune state.
FROM build AS pruned
RUN npm prune --omit=dev --ignore-scripts

# ─────────────────────────────────────────────────────────────── runtime ──
FROM node:22.20-bookworm-slim AS runtime

# `node` (uid 1000) ships with the image. A process that cannot write to its
# own filesystem cannot be made to persist an attacker's payload, so the
# container is also expected to run with a read-only root filesystem.
USER node
WORKDIR /app

ENV NODE_ENV=production
# Node's own defaults assume a machine, not a container's memory limit.
ENV NODE_OPTIONS="--max-old-space-size=384"

# Which build this is, baked into the image so `/version` can say so.
#
# docs/DEPLOYMENT.md has always passed `--build-arg BUILD_COMMIT=...` and
# `--build-arg BUILD_TIME=...`, but until 2026-09-19 nothing here declared
# either ARG, so Docker discarded both with a warning and every image reported
# `commit: unknown`. Step 4 of that runbook -- "confirm /version reports the
# commit that was just deployed" -- could therefore never pass or fail; it
# always said unknown. Declared in THIS stage, not at the top: an ARG declared
# before the first FROM is out of scope inside every stage.
#
# The `:-` defaults matter. `BUILD_TIME` is validated as `min(1).optional()`
# (app-config.ts): absent is fine, EMPTY is a config error and the service
# exits 78 at boot. A plain `docker build` with no build args must still
# produce an image that starts.
ARG BUILD_COMMIT
ARG BUILD_TIME
ENV BUILD_COMMIT=${BUILD_COMMIT:-unknown}
ENV BUILD_TIME=${BUILD_TIME:-1970-01-01T00:00:00Z}

COPY --from=pruned --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# The migrations, and not only for `npm run migrate`.
#
# `MIGRATIONS_DIR` resolves to `<app>/db/migrations` from `dist`, and the
# READINESS PROBE reads it on every check to compare the schema this build
# expects against the schema it found. Without the directory that read throws,
# is caught, logs a warning and returns null -- and null is reported as UP.
#
# So an image without this line reports itself ready while unable to tell
# whether its schema matches, and the drift protection is silently inert in the
# only artefact anyone would ever deploy, while passing in every test, where the
# directory is on disk. Found 2026-08-30; `deployment-contract.spec` asserts
# this COPY exists so it cannot be dropped again.
COPY --chown=node:node db/migrations ./db/migrations

EXPOSE 3000

# No HEALTHCHECK: the orchestrator polls /health and /ready over the network,
# which is the same path real traffic takes. A container-local check can pass
# while the port is unreachable from outside.

# Exec form, so the process is PID 1 and receives SIGTERM directly -- shell
# form would swallow it and turn every deploy into a 30-second kill timeout.
CMD ["node", "dist/main.js"]
