# syntax=docker/dockerfile:1.7

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

EXPOSE 3000

# No HEALTHCHECK: the orchestrator polls /health and /ready over the network,
# which is the same path real traffic takes. A container-local check can pass
# while the port is unreachable from outside.

# Exec form, so the process is PID 1 and receives SIGTERM directly -- shell
# form would swallow it and turn every deploy into a 30-second kill timeout.
CMD ["node", "dist/main.js"]
