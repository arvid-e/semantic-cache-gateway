# syntax=docker/dockerfile:1

# Gateway container image (platform-foundation, task 5.1).
#
# Two stages so the runtime image ships only compiled output and production
# dependencies — never the TypeScript sources, dev tooling, or build cache.
#
# The container's job at run time is "migrate, then serve", and the app
# entrypoint (src/index.ts) already IS that sequence: it loads config, runs
# pending migrations, and only begins listening once they succeed — a failed
# migration exits non-zero before the server binds, so traffic never reaches a
# half-migrated schema (Req 8.2, and Req 1.1/1.3 owned by the bootstrap). The
# container therefore just runs that entrypoint directly rather than invoking
# the migration CLI as a separate step, which would migrate a second time.

# Pinned to the runtime the design commits to (Node.js 24 LTS). `slim` (Debian)
# avoids the musl edge cases Alpine can introduce; every runtime dependency here
# is pure JavaScript, so no build toolchain is needed in the final image.
ARG NODE_VERSION=24-slim

# ---- Stage 1: build ---------------------------------------------------------
# Installs the full dependency set (incl. TypeScript) and compiles src/ -> dist/.
FROM node:${NODE_VERSION} AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Build inputs. tsconfig.build.json excludes co-located *.test.ts files so no
# test lands in dist/.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
# Ships dist/ + migrations/ + production node_modules only.
FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only. node-pg-migrate, pg, ioredis, fastify, etc. are
# all runtime `dependencies`, so the migrate + serve steps have everything they
# need without the dev toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# package.json (already copied above) supplies "type": "module" and the
# "#src/*" -> "./dist/*" import map that the compiled code resolves at run time.
COPY --from=build /app/dist ./dist

# The migration runner resolves its directory relative to dist/platform/db/,
# which lands at /app/migrations — so the SQL files must sit beside dist/.
COPY migrations ./migrations

# Drop root: the `node` user ships with the base image and owns nothing it needs
# to write. The service only opens outbound datastore connections and one
# listening socket.
USER node

# Documentation only (the real port comes from HTTP_PORT); matches the default.
EXPOSE 3000

# The bootstrap migrates, then serves (see the file header). Exec form so node
# is PID 1 and receives SIGTERM/SIGINT directly, letting close-with-grace drain
# in-flight requests and close the pool + Redis before exit (Req 1.4).
CMD ["node", "./dist/index.js"]
