const express = require('express');
const pinoHttp = require('pino-http');
const pino = require('pino');
const otel = require('@opentelemetry/api');

const db = require('./db');
const { requireMembership, requirePaymentsService } = require('./auth');
const sales = require('./sales/service');

function createApp(options = {}) {
  const database = options.db || db;
  const COMMIT_SHA = options.commitSha || process.env.COMMIT_SHA || 'unknown';
  const IMAGE_DIGEST = options.imageDigest || process.env.IMAGE_DIGEST || 'unknown';
  const ENVIRONMENT = options.environment || process.env.DEPLOYMENT_ENVIRONMENT || 'prod';
  const STARTED_AT = options.startedAt || new Date().toISOString();

  const logger =
    options.logger ||
    pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: 'pos',
        environment: ENVIRONMENT,
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
    });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use(
    pinoHttp({
      logger,
      customProps: (_req) => {
        const span = otel.trace.getActiveSpan();
        const ctx = span ? span.spanContext() : null;
        return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'pos' });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await database.checkReady();
      res.status(200).json({
        status: 'ready',
        service: 'pos',
        dependencies: { database: 'ok' },
      });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        service: 'pos',
        dependencies: { database: 'down' },
        error: String(err.message || err),
      });
    }
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      service: 'pos',
      commit: COMMIT_SHA,
      digest: IMAGE_DIGEST,
      environment: ENVIRONMENT,
      started_at: STARTED_AT,
    });
  });

  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'pos',
      message: 'TillFlow POS API',
    });
  });

  // --- Attendant / owner API ----------------------------------------------

  app.post('/sales', requireMembership, async (req, res) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      const result = await sales.createSale(database, {
        tenantId: req.actor.tenantId,
        userId: req.actor.userId,
        role: req.actor.role,
        idempotencyKey,
        body: req.body,
      });
      const status = result.created ? 201 : 200;
      res.status(status).json(result.sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/sales/:id', requireMembership, async (req, res) => {
    try {
      const sale = await sales.getSaleForTenant(
        database,
        req.actor.tenantId,
        req.params.id
      );
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/sales/:id/cancel', requireMembership, async (req, res) => {
    try {
      const sale = await sales.cancelSale(database, {
        tenantId: req.actor.tenantId,
        saleId: req.params.id,
        role: req.actor.role,
      });
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  // --- Payments service contract (see docs/contracts/pos-payments-api.md) -

  app.get('/internal/v1/sales/:id', requirePaymentsService, async (req, res) => {
    try {
      const sale = await sales.getSaleById(database, req.params.id);
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post(
    '/internal/v1/sales/:id/awaiting-payment',
    requirePaymentsService,
    async (req, res) => {
      try {
        const sale = await sales.markAwaitingPayment(database, req.params.id);
        if (!sale) {
          return res.status(404).json({ error: 'not_found' });
        }
        return res.status(200).json(sale);
      } catch (err) {
        return sendError(req, res, err);
      }
    }
  );

  app.post('/internal/v1/sales/:id/paid', requirePaymentsService, async (req, res) => {
    try {
      const paidAt = req.body?.paid_at ? new Date(req.body.paid_at) : new Date();
      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({ error: 'invalid_paid_at' });
      }
      const sale = await sales.markPaid(database, req.params.id, paidAt);
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json(sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get(
    '/internal/v1/commission/eligible',
    requirePaymentsService,
    async (req, res) => {
      try {
        const tenantId = req.query.tenant_id;
        const businessDay = req.query.business_day;
        if (!tenantId || !businessDay) {
          return res.status(400).json({
            error: 'validation',
            hint: 'tenant_id and business_day (YYYY-MM-DD, EAT) are required',
          });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDay))) {
          return res.status(400).json({ error: 'validation', hint: 'business_day format' });
        }
        const eligible = await sales.listEligibleForCommission(database, {
          tenantId,
          businessDayEAT: String(businessDay),
        });
        return res.status(200).json({ tenant_id: tenantId, business_day: businessDay, sales: eligible });
      } catch (err) {
        return sendError(req, res, err);
      }
    }
  );

  app.use((err, req, res, _next) => {
    req.log.error({ err }, 'unhandled_error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function sendError(req, res, err) {
  const status = err.status || (err.code === 'ILLEGAL_TRANSITION' ? 409 : 500);
  if (status >= 500) {
    req.log.error({ err }, 'sale_error');
  } else {
    req.log.warn({ err: { message: err.message, code: err.code } }, 'sale_rejected');
  }
  return res.status(status).json({
    error: err.code || 'error',
    message: err.message,
  });
}

module.exports = { createApp };
