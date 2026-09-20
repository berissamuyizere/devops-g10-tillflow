const express = require('express');
const pinoHttp = require('pino-http');
const pino = require('pino');
const otel = require('@opentelemetry/api');

const db = require('./db');
const { requireMembership, requirePaymentsService } = require('./auth');
const sales = require('./sales/service');
const posMetrics = require('./metrics');
const { createPaymentsClient, PaymentsError, PaymentsUnavailableError } = require('./payments/client');
const { createSaleCache } = require('./cache/sales');

function createApp(options = {}) {
  const database = options.db || db;
  let paymentsClient = options.paymentsClient || null;
  function getPaymentsClient() {
    if (!paymentsClient) {
      paymentsClient = createPaymentsClient(options.paymentsClientOptions);
    }
    return paymentsClient;
  }
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

  const saleCache = options.saleCache || createSaleCache({ logger });

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
    const started = performance.now();
    try {
      const idempotencyKey = req.header('idempotency-key');
      const result = await sales.createSale(database, {
        tenantId: req.actor.tenantId,
        userId: req.actor.userId,
        role: req.actor.role,
        idempotencyKey,
        body: req.body,
      });
      posMetrics.recordSaleWrite(result.created ? 'created' : 'replay', performance.now() - started);
      const status = result.created ? 201 : 200;
      res.status(status).json(result.sale);
    } catch (err) {
      posMetrics.recordSaleWrite(
        err.status && err.status < 500 ? 'rejected' : 'error',
        performance.now() - started
      );
      return sendError(req, res, err);
    }
  });

  app.get('/sales/:id', requireMembership, async (req, res) => {
    try {
      const tenantId = req.actor.tenantId;
      const saleId = req.params.id;
      const cached = await saleCache.get(tenantId, saleId);
      if (cached.status === 'hit') {
        posMetrics.recordCacheRequest('hit');
        return res.status(200).json(cached.value);
      }
      posMetrics.recordCacheRequest(cached.status === 'error' ? 'error' : 'miss');

      const sale = await sales.getSaleForTenant(database, tenantId, saleId);
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      await saleCache.set(tenantId, saleId, sale);
      return res.status(200).json(sale);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/sales/:id/pay', requireMembership, async (req, res) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        return res.status(400).json({ error: 'MISSING_IDEMPOTENCY_KEY' });
      }
      const msisdn = req.body?.msisdn;
      if (!msisdn || typeof msisdn !== 'string') {
        return res.status(400).json({ error: 'VALIDATION', message: 'msisdn required' });
      }

      const sale = await sales.getSaleForTenant(database, req.actor.tenantId, req.params.id);
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      if (sale.status === 'cancelled' || sale.status === 'paid') {
        return res.status(409).json({ error: 'sale_not_chargeable', sale_status: sale.status });
      }

      const { payment, replay } = await getPaymentsClient().startCharge({
        saleId: sale.id,
        msisdn,
        idempotencyKey,
      });
      return res.status(replay ? 200 : 201).json(payment);
    } catch (err) {
      return sendPayError(req, res, err);
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
      await saleCache.invalidate(req.actor.tenantId, req.params.id);
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
      const paymentId = req.body?.payment_id;
      const paidAt = req.body?.paid_at ? new Date(req.body.paid_at) : new Date();
      if (!paymentId || typeof paymentId !== 'string') {
        return res.status(400).json({ error: 'VALIDATION', hint: 'payment_id required' });
      }
      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({ error: 'invalid_paid_at' });
      }
      const sale = await sales.markPaid(database, req.params.id, { paymentId, paidAt });
      if (!sale) {
        return res.status(404).json({ error: 'not_found' });
      }
      await saleCache.invalidate(sale.tenant_id, sale.id);
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

function sendPayError(req, res, err) {
  if (err instanceof PaymentsUnavailableError) {
    req.log.error({ err }, 'payments_unavailable');
    return res.status(err.status || 503).json({
      error: err.code || 'PAYMENTS_UNAVAILABLE',
      message: err.message,
    });
  }
  if (err instanceof PaymentsError) {
    const status = err.status || 502;
    if (status >= 500) {
      req.log.error({ err }, 'payments_error');
    } else {
      req.log.warn({ err: { message: err.message, code: err.code } }, 'pay_rejected');
    }
    return res.status(status).json({
      error: err.code || 'payments_error',
      message: err.message,
    });
  }
  if (err.message === 'POS_SERVICE_TOKEN is not set') {
    req.log.error({ err }, 'pay_misconfigured');
    return res.status(500).json({ error: 'misconfigured', hint: 'POS_SERVICE_TOKEN is not set' });
  }
  return sendError(req, res, err);
}

module.exports = { createApp };
