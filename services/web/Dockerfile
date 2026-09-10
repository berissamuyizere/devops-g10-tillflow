# TillFlow web — golden path reference image.
# Multi-stage: builder installs deps, runtime is a minimal Alpine + Node.
# Pinned base at the tag level; digest pinning happens in the build pipeline
# via `docker buildx build --provenance=false --sbom=false --push`.

# --- stage: build -------------------------------------------------------
FROM node:20.17-alpine3.20 AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# --- stage: runtime -----------------------------------------------------
FROM node:20.17-alpine3.20 AS runtime

RUN addgroup -g 10001 app && \
    adduser  -D -H -u 10001 -G app -s /sbin/nologin app && \
    apk add --no-cache dumb-init wget tzdata ca-certificates && \
    ln -sf /usr/share/zoneinfo/Africa/Nairobi /etc/localtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --chown=app:app --from=build /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--require", "./otel-bootstrap.js", "server.js"]
