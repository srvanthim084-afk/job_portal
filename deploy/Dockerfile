# =====================================================================
# TeamLink API + static frontend
#
# One image serves both: the Express API on /api and the prototype as
# static files. Keeping them together means the browser makes same-origin
# requests, so the session cookie needs no cross-site relaxation.
# =====================================================================
FROM node:22-alpine AS deps

WORKDIR /app/api
# Only the manifests first, so `npm ci` is cached until dependencies change.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards signals, so SIGTERM actually reaches
# node and the graceful shutdown in server.js runs.
RUN apk add --no-cache tini curl

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/api/node_modules ./api/node_modules
COPY api/package.json  ./api/package.json
COPY api/src           ./api/src
COPY web               ./web
COPY supabase/migrations ./supabase/migrations
COPY tools/migrate.mjs ./tools/migrate.mjs

# Uploads live on a mounted volume; create the mount point with the right
# owner before dropping privileges.
RUN mkdir -p /app/var/uploads \
 && addgroup -g 10001 -S teamlink \
 && adduser  -u 10001 -S teamlink -G teamlink \
 && chown -R teamlink:teamlink /app/var

# Never run the application as root.
USER teamlink

ENV WEB_DIR=/app/web \
    STORAGE_LOCAL_DIR=/app/var/uploads \
    PORT=8080

EXPOSE 8080

# Checks the API path specifically — a container that can serve static
# files but cannot reach Postgres is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
WORKDIR /app/api
CMD ["node", "src/server.js"]
