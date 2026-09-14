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

# Run as the unprivileged "node" user provided by the base image.
USER node

# The application listens on port 8080 by default (see server.js).
EXPOSE 8080

# Health check: confirm the API responds. The HTTP server only starts after
# the database connection and schema bootstrap complete, so the start period
# is intentionally generous.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/api/nodes', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
