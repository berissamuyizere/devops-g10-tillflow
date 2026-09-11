FROM node:20.17-alpine3.20 AS build

WORKDIR /app/services/payments
COPY services/payments/package.json services/payments/package-lock.json* ./
RUN npm ci --omit=dev

COPY services/payments/ ./
COPY services/_shared/mpesa/ /app/services/_shared/mpesa/

FROM node:20.17-alpine3.20 AS runtime

RUN addgroup -g 10001 app && \
    adduser  -D -H -u 10001 -G app -s /sbin/nologin app && \
    apk add --no-cache dumb-init wget tzdata ca-certificates && \
    ln -sf /usr/share/zoneinfo/Africa/Nairobi /etc/localtime

WORKDIR /app/services/payments
ENV NODE_ENV=production \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    MPESA_MODE=fake

COPY --chown=app:app --from=build /app/services/payments ./
COPY --chown=app:app --from=build /app/services/_shared/mpesa /app/services/_shared/mpesa

USER app

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--require", "./otel-bootstrap.js", "server.js"]
