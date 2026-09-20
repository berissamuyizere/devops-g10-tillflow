const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const { createApp } = require('../src/app');
const { createPosClient } = require('../src/pos/client');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../_shared/mpesa');
const paymentsDb = require('../src/db');
const request = require('supertest');

const POS_URL =
  process.env.POS_DATABASE_URL || 'postgres://pos:pos@127.0.0.1:5433/tillflow_pos';
const PAYMENTS_TOKEN = 'dev-payments-token';
const CALLBACK_SECRET = 'test-callback-secret';
const NOW_MS = Date.UTC(2026, 8, 14, 12, 0, 0);

process.env.PAYMENTS_SERVICE_TOKEN = process.env.PAYMENTS_SERVICE_TOKEN || PAYMENTS_TOKEN;
process.env.POS_SERVICE_TOKEN = process.env.POS_SERVICE_TOKEN || 'dev-pos-token';
process.env.COMMISSION_SERVICE_TOKEN = process.env.COMMISSION_SERVICE_TOKEN || 'dev-commission-token';
const now = () => NOW_MS;

describe('contract: Payments ↔ real POS', () => {
  let posPool;
  let posServer;
  let posBaseUrl;
  let app;
  let mpesa;
  let posClient;
  let fixtures;

  before(async () => {
    posPool = new Pool({ connectionString: POS_URL, options: '-c search_path=pos,public' });

    const posDb = {
      query: (text, params) => posPool.query(text, params),
      checkReady: () => posPool.query('SELECT 1'),
      async withTransaction(fn) {
        const client = await posPool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(client);
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };

    process.env.PAYMENTS_SERVICE_TOKEN = PAYMENTS_TOKEN;

    const posPino = require('../../pos/node_modules/pino');
    const posApp = require('../../pos/src/app').createApp({
      db: posDb,
      logger: posPino({ level: 'silent' }),
    });

    posServer = http.createServer(posApp);
    await new Promise((resolve) => posServer.listen(0, '127.0.0.1', resolve));
    posBaseUrl = `http://127.0.0.1:${posServer.address().port}`;

    await paymentsDb.checkReady();
  });

  after(async () => {
    await new Promise((resolve) => posServer.close(resolve));
    await posPool.end();
    await paymentsDb.closePool();
  });

  beforeEach(async () => {
    await paymentsDb.query(
      'TRUNCATE payments.payout_ledger_sales, payments.payout_ledger, payments.callback_log, payments.payments CASCADE'
    );
    await posPool.query(
      'TRUNCATE pos.sale_lines, pos.sales, pos.attendants, pos.memberships, pos.users, pos.tenants CASCADE'
    );

    const tenantId = randomUUID();
    const attendantId = randomUUID();
    await posPool.query(
      `INSERT INTO pos.tenants (id, name, status, mpesa_till, default_commission_bps)
       VALUES ($1, 'Contract Shop', 'active', '174379', 500)`,
      [tenantId]
    );
    await posPool.query(`INSERT INTO pos.users (id, email) VALUES ($1, $2)`, [
      attendantId,
      `att-${attendantId}@example.com`,
    ]);
    await posPool.query(
      `INSERT INTO pos.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'attendant')`,
      [tenantId, attendantId]
    );
    await posPool.query(
      `INSERT INTO pos.attendants (id, tenant_id, display_name, payout_msisdn, commission_bps, status)
       VALUES ($1, $2, 'Ada', '254700000001', 500, 'active')`,
      [attendantId, tenantId]
    );
    fixtures = { tenantId, attendantId };

    mpesa = createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET, now });
    posClient = createPosClient({ baseUrl: posBaseUrl, token: PAYMENTS_TOKEN });
    app = createApp({
      db: paymentsDb,
      mpesa,
      pos: posClient,
      now,
      callbackSecret: CALLBACK_SECRET,
      callbackUrl: 'https://tillflow.test/payments/callback',
      logger: require('pino')({ level: 'silent' }),
    });
  });

    async function createSale(idempotencyKey = 'contract-sale-1') {
    const res = await fetch(`${posBaseUrl}/sales`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-tenant-id': fixtures.tenantId,
        'x-user-id': fixtures.attendantId,
        'x-role': 'attendant',
      },
      body: JSON.stringify({
        lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }],
      }),
    });
    assert.equal(res.status, 201, 'POS should create the sale');
    return res.json();
  }

  async function readSale(saleId) {
    const res = await fetch(`${posBaseUrl}/internal/v1/sales/${saleId}`, {
      headers: { 'x-payments-token': PAYMENTS_TOKEN },
    });
    return res.status === 200 ? res.json() : null;
  }

  it('the sale read returns the fields Payments actually depends on', async () => {
    const sale = await createSale();
    const viaClient = await posClient.getSale(sale.id);

    assert.equal(viaClient.id, sale.id);
    assert.equal(viaClient.status, 'created');
    assert.equal(viaClient.total_minor, 15000, 'the amount Payments will charge');
    assert.equal(viaClient.mpesa_till, '174379', 'the till Payments will charge to');
    assert.equal(viaClient.currency, 'KES');
    assert.equal(viaClient.tenant_id, fixtures.tenantId);
    assert.ok(viaClient.attendant, 'attendant block is present for payouts');
    assert.ok(viaClient.attendant.payout_msisdn);
  });

  it('drives a real sale from created to paid end to end', async () => {
    const sale = await createSale();

    const charge = await request(app)
      .post('/internal/v1/charges')
      .set({ 'x-pos-token': 'dev-pos-token', 'idempotency-key': 'contract-charge-1' })
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });

    assert.equal(charge.status, 201);
    assert.equal(charge.body.status, 'pending');
    assert.equal(charge.body.amount_minor, 15000);

    assert.equal((await readSale(sale.id)).status, 'awaiting_payment');

    const body = mpesa.buildCallback(charge.body.checkout_request_id);
    const signed = mpesa.signBody(body, NOW_MS);
    const cb = await request(app)
      .post('/payments/callback')
      .set('content-type', 'application/json')
      .set(signed.headers)
      .send(signed.raw);

    assert.equal(cb.status, 200);
    assert.equal(cb.body.status, 'paid');

    const finalSale = await readSale(sale.id);
    assert.equal(finalSale.status, 'paid');
    assert.ok(finalSale.paid_at, 'POS recorded paid_at');
  });

  it('replaying the charge key and the callback yields one charge and one paid_at', async () => {
    const sale = await createSale();
    const headers = { 'x-pos-token': 'dev-pos-token', 'idempotency-key': 'contract-replay' };

    const first = await request(app)
      .post('/internal/v1/charges')
      .set(headers)
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });
    assert.equal(first.status, 201);

    const replay = await request(app)
      .post('/internal/v1/charges')
      .set(headers)
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, first.body.id, 'same payment id');
    assert.equal(replay.body.replay, true);

    const body = mpesa.buildCallback(first.body.checkout_request_id);
    const signed = mpesa.signBody(body, NOW_MS);
    const send = () =>
      request(app)
        .post('/payments/callback')
        .set('content-type', 'application/json')
        .set(signed.headers)
        .send(signed.raw);

    const cb1 = await send();
    assert.equal(cb1.body.status, 'paid');
    const paidAtAfterFirst = (await readSale(sale.id)).paid_at;

    const cb2 = await send();
    assert.equal(cb2.body.replay, true);

    assert.equal(
      (await readSale(sale.id)).paid_at,
      paidAtAfterFirst,
      'paid_at must not move on replay'
    );

    const count = await paymentsDb.query(
      `SELECT count(*)::int AS n FROM payments.payments WHERE sale_id = $1`,
      [sale.id]
    );
    assert.equal(count.rows[0].n, 1, 'exactly one charge for the sale');
  });

  it('POS rejects a cancel once Payments has taken the sale (frozen invariant 2)', async () => {
    const sale = await createSale();

    await request(app)
      .post('/internal/v1/charges')
      .set({ 'x-pos-token': 'dev-pos-token', 'idempotency-key': 'contract-cancel' })
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });

    assert.equal((await readSale(sale.id)).status, 'awaiting_payment');

    const cancel = await fetch(`${posBaseUrl}/sales/${sale.id}/cancel`, {
      method: 'POST',
      headers: {
        'x-tenant-id': fixtures.tenantId,
        'x-user-id': fixtures.attendantId,
        'x-role': 'attendant',
      },
    });

    assert.equal(cancel.status, 409, 'a cancel must not race a success callback');
    assert.equal((await readSale(sale.id)).status, 'awaiting_payment');
  });

  it('a timeout leaves both the payment and the sale pending, then reconcile settles both', async () => {
    const sale = await createSale();

    const charge = await request(app)
      .post('/internal/v1/charges')
      .set({ 'x-pos-token': 'dev-pos-token', 'idempotency-key': 'contract-timeout' })
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.PUSH_TIMEOUT });

    assert.equal(charge.body.status, 'pending', 'a timeout is never a failure');
    assert.equal((await readSale(sale.id)).status, 'awaiting_payment');

    mpesa.stkQuery = async () => ({
      merchantRequestId: 'mr',
      checkoutRequestId: charge.body.checkout_request_id,
      resultCode: 0,
      resultDesc: 'ok',
      mpesaReceipt: 'RCP-CONTRACT',
      amountMinor: 15000,
    });

    const reconciled = await request(app)
      .post(`/internal/v1/payments/${charge.body.id}/reconcile`)
      .set({ 'x-pos-token': 'dev-pos-token' })
      .send({});

    assert.equal(reconciled.body.status, 'paid');
    assert.equal((await readSale(sale.id)).status, 'paid');
  });

  it('POS refuses Payments calls without the service token', async () => {
    const sale = await createSale();
    const res = await fetch(`${posBaseUrl}/internal/v1/sales/${sale.id}`, {
      headers: { 'x-payments-token': 'wrong-token' },
    });
    assert.equal(res.status, 401);
  });
});
