# syntax=docker/dockerfile:1
#
# LLmRoute Portal — production image
#
# Multi-stage build for Next.js 16 standalone output:
#   1. base   — pnpm-enabled node:22-alpine
#   2. deps   — pnpm install --frozen-lockfile (cacheable)
#   3. builder — prisma generate + next build (with dummy env vars so module
#                load doesn't crash on missing prod secrets at build time)
#   4. runner — minimal alpine image with .next/standalone + start.sh
#
# Container port: 3002 (matches docker-compose.prod.yml host mapping). The
# host Nginx proxies https://llmroute.club → host:3002 → container:3002.
#
# start.sh runs `prisma migrate deploy` once on container start, then exec's
# `node server.js`. So the runtime needs DATABASE_URL pointing at a reachable
# Postgres before the container is healthy.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── deps ───────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── builder ────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate

# Public values used by Next.js during `next build`. Compose maps the server
# .env into these build args; the defaults keep a direct `docker build`
# LLmRoute-safe as well. NEXT_PUBLIC_* values are compiled into client assets
# and cannot be changed by only restarting the finished container.
ARG APP_URL=https://llmroute.club
ARG NEXT_PUBLIC_APP_URL=https://llmroute.club
ARG NEXT_PUBLIC_API_URL=https://api.llmroute.club
ARG NEXT_PUBLIC_IMAGE_URL=https://images.llmroute.club
ARG NEXT_PUBLIC_SUPPORT_EMAIL=support@llmroute.club
ARG NEXT_PUBLIC_SUPPORT_WECHAT=LLmRoute
ARG NEXT_PUBLIC_ENTERPRISE_BASE_URL=http://128.241.232.23

# next build prerenders some routes that import modules touching env at load
# time (newapi/client.ts checks NEWAPI_ADMIN_TOKEN, jwt.ts checks
# PORTAL_JWT_SECRET, etc). Without dummies the build crashes. These values
# are NEVER used at runtime — the real values come from .env via docker-
# compose env_file.
#
# APP_URL remains available at runtime through compose env_file for server-side
# helpers. The values below only make the build deterministic.
RUN DATABASE_URL="postgresql://x:x@localhost:5432/x" \
    NEWAPI_BASE_URL="http://localhost:3000" \
    NEWAPI_ADMIN_TOKEN="build-dummy-token" \
    NEWAPI_ADMIN_USER_ID="1" \
    PORTAL_JWT_SECRET="build-dummy-jwt-secret-at-least-32-chars-padding-padding" \
    ADMIN_TOKEN="build-dummy-admin-token" \
    APP_URL="${APP_URL}" \
    NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL}" \
    NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
    NEXT_PUBLIC_IMAGE_URL="${NEXT_PUBLIC_IMAGE_URL}" \
    NEXT_PUBLIC_SUPPORT_EMAIL="${NEXT_PUBLIC_SUPPORT_EMAIL}" \
    NEXT_PUBLIC_SUPPORT_WECHAT="${NEXT_PUBLIC_SUPPORT_WECHAT}" \
    NEXT_PUBLIC_ENTERPRISE_BASE_URL="${NEXT_PUBLIC_ENTERPRISE_BASE_URL}" \
    pnpm build

# ── runner ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Non-root for runtime
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Standalone output already includes the trace-pruned node_modules; we still
# copy the full @prisma + .pnpm dirs because start.sh shells out to the
# prisma CLI (it's not in standalone's traced dependency graph).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/start.sh ./start.sh

# Resolve the prisma CLI from .pnpm (path includes a content hash so we
# can't hardcode it) and symlink to a stable location for start.sh.
RUN chmod +x start.sh && \
    PRISMA_PKG=$(find node_modules/.pnpm -path '*/prisma/build/index.js' -type f | head -1 | sed 's|/build/index.js||') && \
    ln -s /app/$PRISMA_PKG node_modules/prisma

USER nextjs
EXPOSE 3002
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
CMD ["./start.sh"]
