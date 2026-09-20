const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const otel = require('@opentelemetry/api');

function createApp({ logger } = {}) {
  const log =
    logger ||
    pino({
      level: process.env.LOG_LEVEL || 'info',
      base: { service: 'commission' },
      mixin() {
        const span = otel.trace.getActiveSpan();
        const ctx = span ? span.spanContext() : null;
        return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
    });
  const app = express();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger: log,
      customProps: () => {
        const span = otel.trace.getActiveSpan();
        const ctx = span ? span.spanContext() : null;
        return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'commission' });
  });

  app.get('/ready', (_req, res) => {
    res.status(200).json({ status: 'ready', service: 'commission' });
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      service: 'commission',
      commit: process.env.COMMIT_SHA || 'unknown',
      digest: process.env.IMAGE_DIGEST || 'unknown',
      environment: process.env.DEPLOYMENT_ENVIRONMENT || 'prod',
    });
  });

  return app;
}

module.exports = { createApp };
