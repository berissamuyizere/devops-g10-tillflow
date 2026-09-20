const pino = require('pino');
const otel = require('@opentelemetry/api');
const { createApp } = require('./src/app');
const { startPoller } = require('./src/poller');

const PORT = Number(process.env.PORT || 8080);
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'commission' },
  mixin() {
    const span = otel.trace.getActiveSpan();
    const ctx = span ? span.spanContext() : null;
    return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
  },
});

const app = createApp({ logger });
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, commit: process.env.COMMIT_SHA || 'unknown' }, 'commission_started');
});

const poller = startPoller({
  queueUrl: process.env.SQS_QUEUE_URL,
  region: process.env.AWS_REGION || 'eu-central-1',
  posBaseUrl: process.env.POS_BASE_URL,
  paymentsBaseUrl: process.env.PAYMENTS_BASE_URL,
  paymentsToken: (process.env.PAYMENTS_SERVICE_TOKEN || '').trim(),
  commissionToken: (process.env.COMMISSION_SERVICE_TOKEN || '').trim(),
  tenantIds: process.env.COMMISSION_TENANT_IDS,
  logger,
});

const shutdown = (signal) => {
  logger.info({ signal }, 'commission_shutting_down');
  Promise.resolve(poller.stop())
    .catch(() => {})
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
