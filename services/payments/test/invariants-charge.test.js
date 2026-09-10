const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  createTestApp,
  posHeaders,
  startCharge,
  countRows,
  TEST_MSISDNS,
} = require('./support/helpers');

describe('charge invariants', () => {
  let app;
  let mpesa;
  let pos;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    ({ app, mpesa, pos } = createTestApp());
  });

  after(async () => {
    await db.closePool();
  });

  it('missing Idempotency-Key → 400', async () => {
    const sale = pos.addSale();
    const res = await request(app)
      .post('/internal/v1/charges')
      .set(posHeaders())
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'MISSING_IDEMPOTENCY_KEY');
    assert.equal(await countRows('payments'), 0);
  });

  it('replayed charge → one payment, one STK push', async () => {
    const sale = pos.addSale();
    let pushes = 0;
    const originalPush = mpesa.stkPush;
    mpesa.stkPush = async (req) => {
      pushes += 1;
      return originalPush(req);
    };

    const first = await startCharge(app, pos, { sale, key: 'replay-key' });
    assert.equal(first.res.status, 201);
    assert.equal(first.payment.status, 'pending');

    const second = await startCharge(app, pos, { sale, key: 'replay-key' });
    assert.equal(second.res.status, 200);
    assert.equal(second.res.body.replay, true);
    assert.equal(second.payment.id, first.payment.id);

    const third = await startCharge(app, pos, { sale, key: 'replay-key' });
    assert.equal(third.payment.id, first.payment.id);

    assert.equal(await countRows('payments'), 1, 'exactly one payment row');
    assert.equal(pushes, 1, 'the replay must never reach Daraja again');
  });

  it('same key with a different sale → 409, no second payment', async () => {
    const saleA = pos.addSale();
    const saleB = pos.addSale({ tenant_id: saleA.tenant_id });

    const first = await startCharge(app, pos, { sale: saleA, key: 'shared-key' });
    assert.equal(first.res.status, 201);

    const second = await startCharge(app, pos, { sale: saleB, key: 'shared-key' });
    assert.equal(second.res.status, 409);
    assert.equal(second.res.body.error, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await countRows('payments'), 1);
  });

  it('a different key on the same sale cannot open a second charge', async () => {
    const sale = pos.addSale();

    const first = await startCharge(app, pos, { sale, key: 'key-a' });
    assert.equal(first.res.status, 201);

    const second = await startCharge(app, pos, { sale, key: 'key-b' });
    assert.equal(second.res.status, 409);
    assert.equal(second.res.body.error, 'PAYMENT_ALREADY_EXISTS');
    assert.equal(await countRows('payments'), 1);
  });

  it('a Daraja timeout leaves the payment pending — never failed', async () => {
    const { res, sale, payment } = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.PUSH_TIMEOUT,
      key: 'timeout-key',
    });

    assert.equal(res.status, 201);
    assert.equal(
      payment.status,
      'pending',
      'silence from Daraja is not evidence of non-payment (ADR-002)'
    );

    const row = await db.query(
      `SELECT status, failure_reason, checkout_request_id FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(row.rows[0].status, 'pending');
    assert.equal(row.rows[0].failure_reason, null);
    assert.ok(
      row.rows[0].checkout_request_id,
      'the correlation id must survive the timeout so reconciliation can settle it'
    );

    assert.notEqual(pos.sales.get(sale.id).status, 'cancelled');
    assert.notEqual(pos.sales.get(sale.id).status, 'paid');
    assert.equal(pos.calls.markPaid, 0);
  });

  it('an accepted push that never calls back stays pending until reconciled', async () => {
    const { payment } = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.NO_CALLBACK,
      key: 'silent-key',
    });
    assert.equal(payment.status, 'pending');

    const reconciled = await request(app)
      .post(`/internal/v1/payments/${payment.id}/reconcile`)
      .set(posHeaders())
      .send({});

    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.status, 'pending');
    assert.equal(reconciled.body.reconcile_reason, 'still_processing');
  });

  it('reconciliation is the only path to timed_out, and it settles a real success', async () => {
    const expired = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.NO_CALLBACK,
      key: 'expired-key',
    });
    mpesa.settle(expired.payment.checkout_request_id, 'expired');

    const originalQuery = mpesa.stkQuery;
    mpesa.stkQuery = async () => ({
      merchantRequestId: 'mr',
      checkoutRequestId: expired.payment.checkout_request_id,
      resultCode: 1037,
      resultDesc: 'DS timeout user cannot be reached',
      mpesaReceipt: null,
      amountMinor: null,
    });

    const res = await request(app)
      .post(`/internal/v1/payments/${expired.payment.id}/reconcile`)
      .set(posHeaders())
      .send({});

    assert.equal(res.body.status, 'timed_out');
    const row = await db.query(`SELECT timed_out_at FROM payments.payments WHERE id = $1`, [
      expired.payment.id,
    ]);
    assert.ok(row.rows[0].timed_out_at);
    mpesa.stkQuery = originalQuery;
  });

  it('reconciliation settles a payment whose callback was lost', async () => {
    const { sale, payment } = await startCharge(app, pos, { key: 'lost-callback' });
    assert.equal(payment.status, 'pending');

    const res = await request(app)
      .post(`/internal/v1/payments/${payment.id}/reconcile`)
      .set(posHeaders())
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'paid');
    assert.equal(pos.sales.get(sale.id).status, 'paid');
    assert.equal(await countRows('payments'), 1);
  });

  it('a cancelled or already-paid sale cannot be charged', async () => {
    const cancelled = pos.addSale({ status: 'cancelled' });
    const res = await startCharge(app, pos, { sale: cancelled, key: 'cancelled-key' });
    assert.equal(res.res.status, 409);
    assert.equal(res.res.body.error, 'sale_not_chargeable');
    assert.equal(await countRows('payments'), 0);
  });

  it('an unknown sale is rejected before any payment row exists', async () => {
    const res = await request(app)
      .post('/internal/v1/charges')
      .set(posHeaders({ 'idempotency-key': 'ghost' }))
      .send({ sale_id: '11111111-1111-4111-8111-111111111111', msisdn: TEST_MSISDNS.SUCCESS });

    assert.equal(res.status, 404);
    assert.equal(await countRows('payments'), 0);
  });

  it('requires the POS service token', async () => {
    const sale = pos.addSale();
    const res = await request(app)
      .post('/internal/v1/charges')
      .set({ 'idempotency-key': 'no-token' })
      .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });
    assert.equal(res.status, 401);
  });
});
