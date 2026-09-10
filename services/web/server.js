// TillFlow web / API shell.
//
// G1 scope: prove the golden path — non-root, read-only rootfs, /health,
// /ready, JSON logs with trace_id/span_id, OTel spans exported to the
// ADOT sidecar, and a self-identifying /version endpoint the pipeline can
// smoke-test after deploy. POS routing lands in G2 (Berissa).

const express = require('express');
const pinoHttp = require('pino-http');
const pino = require('pino');
const otel = require('@opentelemetry/api');

const PORT = Number(process.env.PORT || 8080);
const COMMIT_SHA = process.env.COMMIT_SHA || 'unknown';
const IMAGE_DIGEST = process.env.IMAGE_DIGEST || 'unknown';
const ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT || 'prod';
const STARTED_AT = new Date().toISOString();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'web',
    environment: ENVIRONMENT,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Attach trace_id/span_id to every log line and to responses via
// x-amzn-trace-id when present (API Gateway forwards it).
app.use(
  pinoHttp({
    logger,
    customProps: (_req) => {
      const span = otel.trace.getActiveSpan();
      const ctx = span ? span.spanContext() : null;
      return ctx
        ? { trace_id: ctx.traceId, span_id: ctx.spanId }
        : {};
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      }),
    },
    // /health + /ready are excluded from log noise but still traced.
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/ready',
    },
  })
);

// Liveness — the process is up. Under 100ms, no dependency calls.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'web' });
});

// Readiness — we are willing to serve traffic. G1: no deps to check yet;
// G2 will add DB/cache probes.
app.get('/ready', (_req, res) => {
  res.status(200).json({
    status: 'ready',
    service: 'web',
    dependencies: {},
  });
});

app.get('/version', (_req, res) => {
  res.status(200).json({
    service: 'web',
    commit: COMMIT_SHA,
    digest: IMAGE_DIGEST,
    environment: ENVIRONMENT,
    started_at: STARTED_AT,
  });
});

// Placeholder for the sale-create flow — Berissa wires the real POS proxy
// at G2. Returns 501 today so nobody accidentally treats web as POS.
app.post('/sales', (req, res) => {
  req.log.debug('sales_placeholder_hit');
  res
    .status(501)
    .json({ error: 'not implemented', hint: 'POS API lands at G2' });
});

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'web',
    message: 'TillFlow — G1 golden path',
  });
});

// Explicit error handler so all failures produce JSON, not HTML.
// 4-arg signature is required by Express to detect it as an error handler,
// even though `_next` is unused.
app.use((err, req, res, _next) => {
  req.log.error({ err }, 'unhandled_error');
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      commit: COMMIT_SHA,
      digest: IMAGE_DIGEST,
    },
    'web_started'
  );
});

const shutdown = (signal) => {
  logger.info({ signal }, 'web_shutting_down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
