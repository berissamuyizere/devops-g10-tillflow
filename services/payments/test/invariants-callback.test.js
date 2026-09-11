const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  createTestApp,
  postCallback,
  startCharge,
  countRows,
  TEST_MSISDNS,
  NOW_MS,
} = require('./support/helpers');

describe('callback invariants', () => {
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

  it('duplicate callback → one charge, second is a logged no-op', async () => {
    const { sale, payment } = await startCharge(app, pos);
    const body = mpesa.buildCallback(payment.checkout_request_id);

    const first = await postCallback(app, mpesa, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.applied, true);
    assert.equal(first.body.status, 'paid');

    const second = await postCallback(app, mpesa, body);
    assert.equal(second.status, 200);
    assert.equal(second.body.replay, true);

    const third = await postCallback(app, mpesa, body);
    assert.equal(third.status, 200);
    assert.equal(third.body.replay, true);

    const rows = await db.query(
      `SELECT status, mpesa_receipt, paid_at FROM payments.payments WHERE sale_id = $1`,
      [sale.id]
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].status, 'paid');
    assert.ok(rows.rows[0].mpesa_receipt);

    assert.equal(await countRows('callback_log', "WHERE outcome = 'applied'"), 1);

    assert.equal(await countRows('callback_log'), 1);

    assert.equal(pos.sales.get(sale.id).status, 'paid');
  });

  it('out-of-order callback cannot regress a paid payment', async () => {
    const { payment } = await startCharge(app, pos);
    const success = mpesa.buildCallback(payment.checkout_request_id);

    const applied = await postCallback(app, mpesa, success);
    assert.equal(applied.body.status, 'paid');

    const lateDecline = mpesa.buildCallback(payment.checkout_request_id, {
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
    });
    const res = await postCallback(app, mpesa, lateDecline);

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'illegal_transition');
    assert.equal(res.body.from, 'paid');

    const after = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [
      payment.id,
    ]);
    assert.equal(after.rows[0].status, 'paid');

    const logged = await db.query(
      `SELECT outcome FROM payments.callback_log WHERE outcome = 'rejected_illegal_transition'`
    );
    assert.equal(logged.rowCount, 1, 'illegal transition must be logged, not silently dropped');
  });

  it('callback for an unknown checkout id is rejected and mutates nothing', async () => {
    const { payment } = await startCharge(app, pos);

    const forged = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'mr-forged',
          CheckoutRequestID: 'ws_CO-does-not-exist',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 150 },
              { Name: 'MpesaReceiptNumber', Value: 'FORGED123' },
            ],
          },
        },
      },
    };

    const res = await postCallback(app, mpesa, forged);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown_payment');

    const untouched = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [
      payment.id,
    ]);
    assert.equal(untouched.rows[0].status, 'pending');
    assert.equal(await countRows('callback_log', "WHERE outcome = 'rejected_unknown_payment'"), 1);
  });

  it('callback carrying the wrong amount is rejected', async () => {
    const { payment } = await startCharge(app, pos);
    const inflated = mpesa.buildCallback(payment.checkout_request_id, {
      amountMinor: 999900,
    });

    const res = await postCallback(app, mpesa, inflated);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'amount_mismatch');

    const after = await db.query(
      `SELECT status, amount_minor FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(after.rows[0].status, 'pending');
    assert.equal(after.rows[0].amount_minor, 15000);
  });

  it('unsigned and mis-signed callbacks are rejected', async () => {
    const { payment } = await startCharge(app, pos);
    const body = mpesa.buildCallback(payment.checkout_request_id);

    const unsigned = await request(app)
      .post('/payments/callback')
      .set('content-type', 'application/json')
      .send(JSON.stringify(body));
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.reason, 'signature_header_malformed');

    const wrongSecret = await request(app)
      .post('/payments/callback')
      .set('content-type', 'application/json')
      .set('x-tillflow-signature', 't=1757500000,v1=deadbeef')
      .send(JSON.stringify(body));
    assert.equal(wrongSecret.status, 401);

    const stale = await postCallback(app, mpesa, body, { atMs: NOW_MS - 3600_000 });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.reason, 'signature_timestamp_outside_tolerance');

    const after = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [
      payment.id,
    ]);
    assert.equal(after.rows[0].status, 'pending', 'no unauthenticated callback may settle a payment');
    assert.equal(await countRows('callback_log', "WHERE outcome = 'rejected_bad_signature'"), 3);
  });

  it('a decline callback fails the payment without touching the sale', async () => {
    const { sale, payment } = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.INSUFFICIENT_FUNDS,
    });
    const body = mpesa.buildCallback(payment.checkout_request_id);

    const res = await postCallback(app, mpesa, body);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'failed');

    const after = await db.query(
      `SELECT status, result_code FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(after.rows[0].status, 'failed');
    assert.equal(after.rows[0].result_code, 1);

    assert.equal(pos.sales.get(sale.id).status, 'awaiting_payment');
    assert.equal(pos.calls.markPaid, 0);
  });

  it('a 1037 callback is informational — the payment stays pending', async () => {
    const { payment } = await startCharge(app, pos);
    const noResponse = mpesa.buildCallback(payment.checkout_request_id, {
      resultCode: 1037,
      resultDesc: 'DS timeout user cannot be reached',
    });

    const res = await postCallback(app, mpesa, noResponse);
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, false);

    const after = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [
      payment.id,
    ]);
    assert.equal(
      after.rows[0].status,
      'pending',
      '1037 on a bare callback is silence, not a decline — only reconciliation may call it terminal'
    );
  });
});
