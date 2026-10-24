# syntax=docker/dockerfile:1

# Crime Board / Investigation Network Graph — production runtime image.
#
# Built by .github/workflows/build.yml with:
#   context: .
#   file:    ./Dockerfile (build-push-action default)
#   platforms: linux/amd64,linux/arm64
#   tags:    ghcr.io/ivancarlosti/criminalmap:latest (and :<version>)
#
# No build args are passed by the workflow, so none are expected here.
#
# Base image: Node.js 24 LTS on Alpine. Node.js 20 reached end-of-life on
# 2026-04-30, so the previous node:20-alpine base no longer received Node
# security patches and its pinned Alpine release lagged behind the current
# openssl/musl/zlib fixes. node:24-alpine tracks the supported LTS line (until
# April 2028) and the current Alpine base, which is what removes the OS-level
# and Node.js vulnerabilities reported against the old tag.

FROM node:24-alpine

# Force a strict production runtime.
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first to take advantage of Docker layer caching.
# npm install (rather than npm ci) is used because no lockfile is
# guaranteed to be present in this repository.
COPY package*.json ./
RUN npm install --omit=dev

# Keep the npm shipped in the image on the latest release. The copy bundled with
# node:24-alpine lags behind the registry, and its vendored transitive
# dependencies (brace-expansion, http-cache-semantics, undici) are the only
# HIGH findings left after the Node.js/Alpine layers are scanned clean. npm is
# not used by the running application, but scanners inspect it because it ships
# in the image. Pinned for reproducible builds — bump it with the base image.
RUN npm install -g npm@12.2.1 \
 && npm cache clean --force

# Copy only the runtime files referenced by server.js.
COPY server.js ./
COPY src/ ./src/
COPY db/ ./db/
COPY public/ ./public/
COPY views/ ./views/

# Generated OpenGraph cards live outside the application tree so they can be
# kept on a volume (docker/docker-compose.yml maps ./webimages here). WEBIMAGES_DIR
# points the application at it, and the directory is created while still root so
# the unprivileged runtime user can write to a fresh named volume — a bind mount
# keeps the permissions of the host directory, which is documented in the README.
ENV WEBIMAGES_DIR=/app/webimages
RUN mkdir -p /app/webimages/maps && chown -R node:node /app/webimages

# Run as the unprivileged "node" user provided by the base image.
USER node

# The application listens on 8080 by default (see server.js). Overriding PORT
# inside the container is possible, but then the container side of the compose
# port mapping must match it.
EXPOSE 8080

# Health check: GET /api/settings is public (no session needed) and only answers
# 200 once the database connection, the schema bootstrap and the settings cache
# are ready — exactly the readiness signal this check needs. The port is read
# from $PORT inside the Node process, so the check follows an overridden port
# instead of assuming 8080. The start period is intentionally generous because
# the HTTP server starts only after the database work above.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const p = process.env.PORT || 8080; require('http').get('http://127.0.0.1:' + p + '/api/settings', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"]

CMD ["node", "server.js"]
