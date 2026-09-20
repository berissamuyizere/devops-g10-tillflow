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
const payoutCallbacks = require('./payouts/callbacks');
const metrics = require('./metrics');
const tracing = require('./tracing');
const pathAuth = require('./payments/path-auth');
const { createReconcileSweep } = require('./payments/reconcile-sweep');

function callbackOutcomeLabel(outcome) {
  if (outcome === 'applied') return 'applied';
  if (outcome === 'replay_noop') return 'replay';
  return 'rejected';
}

function ageMs(since, now) {
  if (!since) return undefined;
  const started = new Date(since).getTime();
  if (!Number.isFinite(started)) return undefined;
  const delta = now - started;
  return delta >= 0 ? delta : undefined;
}

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
    options.callbackSecret || (process.env.DARAJA_CALLBACK_SECRET || '').trim() || null;
  const CALLBACK_URL =
    options.callbackUrl || process.env.DARAJA_CALLBACK_URL || 'https://localhost/payments/callback';
  const CALLBACK_PATH_SECRET =
    options.callbackPathSecret ||
    (process.env.DARAJA_CALLBACK_PATH_SECRET || '').trim() ||
    null;
  const CALLBACK_IP_ALLOWLIST = pathAuth.parseAllowlist(
    options.callbackIpAllowlist ?? process.env.DARAJA_CALLBACK_IP_ALLOWLIST ?? ''
  );

  const metricsRefresh =
    options.metricsRefresh === false
      ? null
      : metrics.startDbRefresh(database, {
          intervalMs: Number(process.env.METRICS_REFRESH_MS || 15000),
        });

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

      tracing.annotate({ [tracing.ATTR.SALE_ID]: saleId });

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

  app.post('/internal/v1/pos-sync/sweep', requirePosService, async (req, res) => {
    try {
      const limit = Math.min(Number(req.body?.limit) || 100, 500);
      const result = await paymentsService.sweepPosSync(database, pos, { limit });
      req.log.info(result, 'pos_sync_sweep');
      return res.status(200).json(result);
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
    if (!CALLBACK_SECRET) {
      req.log.error({ env: 'DARAJA_CALLBACK_SECRET' }, 'callback_secret_not_configured');
      return res.status(500).json({ error: 'misconfigured', hint: 'DARAJA_CALLBACK_SECRET is not set' });
    }
    try {
      const result = await callbacks.handleCallback(database, pos, {
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        headers: req.headers,
        secret: CALLBACK_SECRET,
        now,
        logger: req.log,
      });
      tracing.annotatePayment(result.payment);
      tracing.annotateCallbackOutcome(result.outcome);
      metrics.recordCallback(
        'stk',
        callbackOutcomeLabel(result.outcome),
        ageMs(result.payment?.created_at, Date.now())
      );
      return res.status(result.status).json(result.body);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/callbacks/mpesa/:secret', async (req, res) => {
    const ip = pathAuth.sourceIp(req);
    const verdict = pathAuth.verifyPath({
      presented: req.params.secret,
      configured: CALLBACK_PATH_SECRET,
      ip,
      allowlist: CALLBACK_IP_ALLOWLIST,
    });

    if (!verdict.configured) {
      req.log.error({ env: 'DARAJA_CALLBACK_PATH_SECRET' }, 'callback_path_secret_not_configured');
      return res.status(500).json({
        error: 'misconfigured',
        hint: 'DARAJA_CALLBACK_PATH_SECRET is not set',
      });
    }

    try {
      const result = await callbacks.handleCallback(database, pos, {
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        headers: req.headers,
        secret: null,
        auth: verdict.valid
          ? { valid: true, reason: verdict.reason }
          : { valid: false, reason: verdict.reason },
        now,
        logger: req.log,
      });
      tracing.annotatePayment(result.payment);
      tracing.annotateCallbackOutcome(result.outcome);
      metrics.recordCallback(
        'stk',
        callbackOutcomeLabel(result.outcome),
        ageMs(result.payment?.created_at, Date.now())
      );
      if (!verdict.valid) {
        req.log.warn({ reason: verdict.reason, ip }, 'callback_path_rejected');
      }
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
        if (recorded.ledger.status === payoutsService.LEDGER_STATUSES.PENDING) {
          const resumed = await payoutsService.disburse(database, mpesa, recorded.ledger.id);
          req.log.warn(
            {
              ledger_id: recorded.ledger.id,
              agent_id: body.agent_id,
              period: body.period,
              reason: resumed.reason,
            },
            'payout_resumed_from_pending'
          );
          return res.status(200).json({
            ...resumed.ledger,
            replay: true,
            resumed: true,
            disburse_reason: resumed.reason,
          });
        }

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
          accepted: disbursed.accepted === true,
          reason: disbursed.reason,
        },
        'payout_b2c_sent'
      );

      return res.status(201).json({ ...disbursed.ledger, disburse_reason: disbursed.reason });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/payments/b2c/callback', async (req, res) => {
    if (!CALLBACK_SECRET) {
      req.log.error({ env: 'DARAJA_CALLBACK_SECRET' }, 'callback_secret_not_configured');
      return res.status(500).json({ error: 'misconfigured', hint: 'DARAJA_CALLBACK_SECRET is not set' });
    }
    try {
      const result = await payoutCallbacks.handleB2cResultCallback(database, {
        rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
        headers: req.headers,
        secret: CALLBACK_SECRET,
        now,
        logger: req.log,
      });
      tracing.annotateLedger(result.ledger);
      tracing.annotateCallbackOutcome(result.outcome);
      metrics.recordCallback(
        'b2c',
        callbackOutcomeLabel(result.outcome),
        ageMs(result.ledger?.accepted_at || result.ledger?.created_at, Date.now())
      );
      return res.status(result.status).json(result.body);
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.post('/internal/v1/payouts/:id/reconcile', requireCommissionService, async (req, res) => {
    try {
      const result = await payoutsService.reconcilePayout(database, mpesa, req.params.id);
      if (!result.ledger) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ ...result.ledger, reconcile_reason: result.reason });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

  app.get('/internal/v1/payouts/by-agent-period', requireCommissionService, async (req, res) => {
    try {
      const agentId = req.query.agent_id;
      const period = req.query.period;
      if (!agentId || !/^\d{4}-\d{2}-\d{2}$/.test(String(period || ''))) {
        return res.status(400).json({
          error: 'VALIDATION',
          hint: 'agent_id and period (YYYY-MM-DD) are required',
        });
      }
      const ledger = await payoutsService.findByAgentPeriod(database, agentId, String(period));
      if (!ledger) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(ledger);
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

  const reconcileSweep =
    options.reconcileSweep === false
      ? null
      : createReconcileSweep(database, mpesa, pos, {
          ...(options.reconcileSweepOptions || {}),
          logger: options.logger || null,
        });
  if (reconcileSweep && process.env.RECONCILE_SWEEP_ENABLED === 'true') {
    reconcileSweep.start();
  }
  app.reconcileSweep = reconcileSweep;
  app.stopMetricsRefresh = () => metricsRefresh?.stop();
  app.stopReconcileSweep = () => reconcileSweep?.stop();

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
