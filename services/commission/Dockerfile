# TillFlow commission worker — golden path (aligned with services/web).
FROM node:20.20.2-alpine3.22 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

COPY . .

FROM node:20.20.2-alpine3.22 AS runtime

RUN addgroup -g 10001 app && \
    adduser  -D -H -u 10001 -G app -s /sbin/nologin app && \
    apk upgrade --no-cache && \
    apk add --no-cache dumb-init wget tzdata ca-certificates && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm \
           /usr/local/bin/npx /opt/yarn-v* /usr/local/bin/yarn && \
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
