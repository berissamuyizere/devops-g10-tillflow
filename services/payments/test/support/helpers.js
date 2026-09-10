const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const db = require('../../src/db');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../../_shared/mpesa');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://payments:payments@127.0.0.1:5434/tillflow_payments';

process.env.DATABASE_URL = DATABASE_URL;

const CALLBACK_SECRET = 'test-callback-secret';
const POS_TOKEN = 'dev-pos-token';
const COMMISSION_TOKEN = 'dev-commission-token';

const NOW_MS = Date.UTC(2026, 8, 10, 12, 0, 0);
const now = () => NOW_MS;

async function resetData() {
  await db.query(
    'TRUNCATE payments.payout_ledger_sales, payments.payout_ledger, payments.callback_log, payments.payments CASCADE'
  );
}

function createFakePos(options = {}) {
  const sales = new Map();
  const calls = { getSale: 0, markAwaitingPayment: 0, markPaid: 0 };

  function addSale(overrides = {}) {
    const sale = {
      id: overrides.id || randomUUID(),
      tenant_id: overrides.tenant_id || randomUUID(),
      attendant_id: overrides.attendant_id || randomUUID(),
      status: overrides.status || 'created',
      currency: 'KES',
      total_minor: overrides.total_minor ?? 15000,
      mpesa_till: overrides.mpesa_till || '174379',
      paid_at: null,
    };
    sales.set(sale.id, sale);
    return sale;
  }

  return {
    addSale,
    sales,
    calls,
    async getSale(saleId) {
      calls.getSale += 1;
      return sales.get(saleId) || null;
    },
    async markAwaitingPayment(saleId) {
      calls.markAwaitingPayment += 1;
      if (options.failAwaitingPayment) throw new Error('pos unavailable');
      const sale = sales.get(saleId);
      if (!sale) return null;
      if (sale.status === 'created') sale.status = 'awaiting_payment';
      return sale;
    },
    async markPaid(saleId, _paymentId, paidAt) {
      calls.markPaid += 1;
      const sale = sales.get(saleId);
      if (!sale) return null;

      if (sale.status !== 'paid') {
        sale.status = 'paid';
        sale.paid_at = paidAt;
      }
      return sale;
    },
  };
}

function createTestApp(overrides = {}) {
  const mpesa = overrides.mpesa || createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET, now });
  const pos = overrides.pos || createFakePos();
  const app = createApp({
    db,
    mpesa,
    pos,
    now,
    callbackSecret: CALLBACK_SECRET,
    callbackUrl: 'https://tillflow.test/payments/callback',
    logger: require('pino')({ level: 'silent' }),
    ...overrides.appOptions,
  });
  return { app, mpesa, pos };
}

function posHeaders(extra = {}) {
  return { 'x-pos-token': POS_TOKEN, ...extra };
}

function commissionHeaders(extra = {}) {
  return { 'x-commission-token': COMMISSION_TOKEN, ...extra };
}

function postCallback(app, mpesa, body, { atMs = NOW_MS } = {}) {
  const signed = mpesa.signBody(body, atMs);
  return request(app)
    .post('/payments/callback')
    .set('content-type', 'application/json')
    .set(signed.headers)
    .send(signed.raw);
}

async function startCharge(app, pos, { msisdn = TEST_MSISDNS.SUCCESS, sale, key = 'chg-1' } = {}) {
  const target = sale || pos.addSale();
  const res = await request(app)
    .post('/internal/v1/charges')
    .set(posHeaders({ 'idempotency-key': key }))
    .send({ sale_id: target.id, msisdn });
  return { res, sale: target, payment: res.body };
}

async function countRows(table, where = '', params = []) {
  const res = await db.query(
    `SELECT count(*)::int AS n FROM payments.${table} ${where}`,
    params
  );
  return res.rows[0].n;
}

module.exports = {
  db,
  request,
  randomUUID,
  resetData,
  createFakePos,
  createTestApp,
  posHeaders,
  commissionHeaders,
  postCallback,
  startCharge,
  countRows,
  TEST_MSISDNS,
  CALLBACK_SECRET,
  NOW_MS,
  now,
  DATABASE_URL,
};
