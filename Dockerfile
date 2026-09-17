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

FROM node:20-alpine

# Force a strict production runtime.
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first to take advantage of Docker layer caching.
# npm install (rather than npm ci) is used because no lockfile is
# guaranteed to be present in this repository.
COPY package*.json ./
RUN npm install --omit=dev

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
