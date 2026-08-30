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

# Drop dev dependencies from what will be copied forward.
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

COPY --from=build --chown=node:node /app/node_modules ./node_modules
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
