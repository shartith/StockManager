# syntax=docker/dockerfile:1.7
# Stock Manager — multi-arch (linux/amd64, linux/arm64) production image.
# Build & push:  ./scripts/build-docker.sh

# ── Stage 1: build client + server ─────────────────────────────────
FROM node:20-alpine AS builder

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Copy manifests first so layer cache survives source edits
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci

COPY server ./server
COPY client ./client

# vue-tsc + vite build (client) → tsc (server)
RUN npm run build


# ── Stage 2: install production-only deps for runtime ──────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Server is the only workspace needed at runtime (client = static files)
RUN npm ci --omit=dev --workspace=server --include-workspace-root


# ── Stage 3: minimal runtime ───────────────────────────────────────
FROM node:20-alpine AS runner

# libstdc++ = better-sqlite3 native binary; tini = clean PID-1 signal handling
# tzdata = KST(Asia/Seoul) — KRX 장 시간/스케줄러가 로컬 시간에 의존
RUN apk add --no-cache libstdc++ libc6-compat tini tzdata \
    && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo "Asia/Seoul" > /etc/timezone \
    && addgroup -S app && adduser -S -G app -H app

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    STOCK_MANAGER_DATA=/data \
    STOCK_MANAGER_CLIENT=/app/client/dist \
    PORT=3001

# npm workspaces hoists all deps to the root node_modules; there is no
# /app/server/node_modules to copy. Node's resolution walks up the tree.
COPY --from=deps    --chown=app:app /app/node_modules        ./node_modules
COPY --from=builder --chown=app:app /app/server/dist         ./server/dist
COPY --from=builder --chown=app:app /app/client/dist         ./client/dist
COPY --from=builder --chown=app:app /app/server/package.json ./server/package.json
COPY --from=builder --chown=app:app /app/package.json        ./package.json

# Persistent data dir (DB, settings.json) — mount a named volume here
RUN mkdir -p /data && chown -R app:app /data /app
VOLUME ["/data"]

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider "http://localhost:${PORT}/" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
