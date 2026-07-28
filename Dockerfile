# syntax=docker/dockerfile:1
# ============================================================================
# SOOYA — multi-stage build.
# Target: a 2 vCPU / 2 GB Linux box. No orchestrator, no external services.
# ============================================================================

# ------------------------------------------------------ production deps only --
# Install runtime dependencies from the lockfile in an isolated stage. Pruning
# the full workspace tree can incorrectly remove hoisted workspace dependencies
# such as better-sqlite3, so the runtime layer is built cleanly instead.
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /prod

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --build-from-source=better-sqlite3 \
  && npm cache clean --force

# ----------------------------------------------------------------- builder --
FROM node:20-bookworm-slim AS builder
WORKDIR /build

# better-sqlite3 is compiled from source so tests/builds use the same ABI as the
# final Node 20 runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --build-from-source=better-sqlite3

COPY tsconfig.base.json* ./
COPY packages ./packages
COPY assets ./assets
COPY scripts ./scripts

RUN npm run build -w @sooya/server \
  && npm run build -w @sooya/web

# ----------------------------------------------------------------- runtime --
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 sooya \
  && useradd --system --uid 1001 --gid sooya --create-home sooya

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    DATA_DIR=/app/data \
    CONFIG_DIR=/app/config \
    WEB_DIR=/app/public \
    SOOYA_ASSETS_DIR=/app/assets/stickers

COPY --from=prod-deps /prod/node_modules ./node_modules
COPY --from=prod-deps /prod/package.json ./package.json
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/server/package.json ./packages/server/package.json
COPY --from=builder /build/packages/web/dist ./public
COPY --from=builder /build/assets ./assets
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data and config are mounted volumes; create them so a bare `docker run` works.
RUN mkdir -p /app/data /app/config \
  && chown -R sooya:sooya /app

USER sooya
VOLUME ["/app/data", "/app/config"]
EXPOSE 8788

# Health checks hit /health/ready, which is intentionally not token-protected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health/ready" || exit 1

# tini reaps zombies; the entrypoint script validates the bind mounts first and
# explains how to fix ownership instead of failing with a bare EACCES.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/main.js"]
