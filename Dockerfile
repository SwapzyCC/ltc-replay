# syntax=docker/dockerfile:1

# ltc-replay — two-stage build.
#
# Debian slim rather than Alpine, deliberately: better-sqlite3 and zeromq are
# native addons, and their prebuilt binaries are published against glibc. On
# musl both fall back to compiling from source, which turns a 30-second image
# build into several minutes and drags a compiler into the runtime layer if
# anyone gets the staging wrong. The size difference is not worth that.
#
# The build toolchain lives only in the builder stage. The runtime stage gets
# the compiled JavaScript, the production dependency tree, and nothing else.

# ── Builder ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

# Present so that a native addon *without* a matching prebuild can still be
# compiled rather than failing the build outright.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies are their own layer: source changes far more often than the
# lockfile, and this keeps the native rebuild out of the common path.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop devDependencies from the tree that will be copied forward. Done after
# the build, since the build needs TypeScript.
RUN npm prune --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The node image already provides an unprivileged `node` user (uid 1000). The
# service binds ports above 1024 and writes only to its data directory, so it
# never needs more than that.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The SQLite journal. Mount a volume here — without one, a container replacement
# discards the block history and the next start re-walks the chain from scratch.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

# Defaults for a container: bind to every interface *inside* the container and
# let Docker's port publishing decide what is actually reachable. Everything
# else comes from the environment — see .env.example.
ENV HTTP_BIND=0.0.0.0 \
    HTTP_PORT=28350 \
    DB_PATH=/app/data/journal.sqlite \
    LOG_FORMAT=json

EXPOSE 28350 28340

# /health is deliberately unauthenticated, so the check needs no secret baked
# into the image. It reports the process, not the chain: a node that has gone
# away is visible in /v1/stats and in the logs, and restarting the relay would
# not fix it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||28350)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node runs as PID 1 here and handles SIGTERM itself — src/index.ts installs the
# handler and App.stop() drains in order. `docker stop` therefore gets a clean
# shutdown, not a kill, provided the grace period allows it.
CMD ["node", "dist/index.js"]
