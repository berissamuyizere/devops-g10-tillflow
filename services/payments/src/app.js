const express = require('express');
const pinoHttp = require('pino-http');
const pino = require('pino');
const otel = require('@opentelemetry/api');

const db = require('./db');
const { requirePosService, requireCommissionService } = require('./auth');
const { createMpesaClient } = require('../../_shared/mpesa');
const { createPosClient } = require('./pos/client');
const paymentsService = require('./payments/service');
const payoutsService = require('./payouts/service');
const callbacks = require('./payments/callbacks');

function createApp(options = {}) {
  const database = options.db || db;
  const mpesa = options.mpesa || createMpesaClient();
  const pos = options.pos || createPosClient();
  const now = options.now || (() => Date.now());

  const COMMIT_SHA = options.commitSha || process.env.COMMIT_SHA || 'unknown';
  const IMAGE_DIGEST = options.imageDigest || process.env.IMAGE_DIGEST || 'unknown';
  const ENVIRONMENT = options.environment || process.env.DEPLOYMENT_ENVIRONMENT || 'prod';
  const STARTED_AT = options.startedAt || new Date().toISOString();
  const CALLBACK_SECRET =
    options.callbackSecret || process.env.DARAJA_CALLBACK_SECRET || 'dev-callback-secret';
  const CALLBACK_URL =
    options.callbackUrl || process.env.DARAJA_CALLBACK_URL || 'https://localhost/payments/callback';

  const logger =
    options.logger ||
    pino({
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { service: 'payments', environment: ENVIRONMENT },
      formatters: { level: (label) => ({ level: label }) },
    });

  const app = express();
  app.disable('x-powered-by');

  app.use(
    express.json({
      limit: '64kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  app.use(
    pinoHttp({
      logger,
      customProps: (_req) => {
        const span = otel.trace.getActiveSpan();
        const ctx = span ? span.spanContext() : null;
        return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'payments' });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await database.checkReady();
      res.status(200).json({
        status: 'ready',
        service: 'payments',
        dependencies: { database: 'ok', mpesa: mpesa.mode || 'daraja' },
      });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        service: 'payments',
        dependencies: { database: 'down' },
        error: String(err.message || err),
      });
    }
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      service: 'payments',
      commit: COMMIT_SHA,
      digest: IMAGE_DIGEST,
      environment: ENVIRONMENT,
      mpesa_mode: mpesa.mode || 'daraja',
      started_at: STARTED_AT,
    });
  });

  app.get('/', (_req, res) => {
    res.status(200).json({ service: 'payments', message: 'TillFlow Payments API' });
  });

  app.post('/internal/v1/charges', requirePosService, async (req, res) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      const { sale_id: saleId, msisdn } = req.body || {};
      if (!saleId || !msisdn) {
        return res.status(400).json({ error: 'VALIDATION', message: 'sale_id and msisdn required' });
      }

      const sale = await pos.getSale(saleId);
      if (!sale) {
        return res.status(404).json({ error: 'sale_not_found' });
      }
      if (sale.status === 'cancelled' || sale.status === 'paid') {
        return res.status(409).json({ error: 'sale_not_chargeable', sale_status: sale.status });
      }

      const reserved = await paymentsService.reservePayment(database, {
        tenantId: sale.tenant_id,
        saleId,
        idempotencyKey,
        sale,
        msisdn,
      });

      if (!reserved.created) {
        return res.status(200).json({ ...reserved.payment, replay: true });
      }

      const pushed = await paymentsService.sendStkPush(database, mpesa, pos, reserved.payment, {
        callbackUrl: CALLBACK_URL,
      });

      req.log.info(
        {
          payment_id: pushed.payment.id,
          sale_id: saleId,
          status: pushed.payment.status,
          timed_out: pushed.timedOut,
        },
        'charge_initiated'
      );

      return res.status(201).json(pushed.payment);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/internal/v1/payments/:id', requirePosService, async (req, res) => {
    try {
      const payment = await paymentsService.getPayment(database, req.params.id);
      if (!payment) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(payment);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/internal/v1/sales/:saleId/payment', requirePosService, async (req, res) => {
    try {
      const payment = await paymentsService.getPaymentForSale(database, req.params.saleId);
      if (!payment) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(payment);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

    app.post('/internal/v1/payments/:id/reconcile', requirePosService, async (req, res) => {
    try {
      const result = await paymentsService.reconcilePayment(database, mpesa, pos, req.params.id);
      if (!result.payment) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ ...result.payment, reconcile_reason: result.reason });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/payments/callback', async (req, res) => {
    try {
      const result = await callbacks.handleCallback(database, pos, {
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        headers: req.headers,
        secret: CALLBACK_SECRET,
        now,
        logger: req.log,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/internal/v1/payouts', requireCommissionService, async (req, res) => {
    try {
      const body = req.body || {};
      const recorded = await payoutsService.recordPayout(database, {
        tenantId: body.tenant_id,
        agentId: body.agent_id,
        period: body.period,
        msisdn: body.msisdn,
        commissionBps: Number(body.commission_bps),
        sales: body.sales,
        idempotencyKey: req.header('idempotency-key') || undefined,
      });

      if (!recorded.created) {
        req.log.info(
          { ledger_id: recorded.ledger.id, agent_id: body.agent_id, period: body.period },
          'payout_replay_noop'
        );
        return res.status(200).json({ ...recorded.ledger, replay: true });
      }

      const disbursed = await payoutsService.disburse(database, mpesa, recorded.ledger.id);
      req.log.info(
        {
          ledger_id: recorded.ledger.id,
          disbursed: disbursed.disbursed,
          reason: disbursed.reason,
        },
        'payout_disbursed'
      );

      return res.status(201).json({ ...disbursed.ledger, disburse_reason: disbursed.reason });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/internal/v1/payouts/:id', requireCommissionService, async (req, res) => {
    try {
      const ledger = await payoutsService.getLedgerEntry(database, req.params.id);
      if (!ledger) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(ledger);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.use((err, req, res, _next) => {
    req.log.error({ err }, 'unhandled_error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function sendError(req, res, err) {
  const status = err.status || (err.code === 'ILLEGAL_TRANSITION' ? 409 : 500);
  if (status >= 500) {
    req.log.error({ err }, 'payments_error');
  } else {
    req.log.warn({ err: { message: err.message, code: err.code } }, 'payments_rejected');
  }
  return res.status(status).json({ error: err.code || 'error', message: err.message });
}

module.exports = { createApp };
