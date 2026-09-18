const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  resetData,
  createTestApp,
  postCallback,
  startCharge,
  countRows,
} = require('./support/helpers');

describe('callback atomicity', () => {
  let app;
  let mpesa;
  let pos;
  let crashAfterWrites;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    crashAfterWrites = false;

    const crashingDb = {
      ...db,
      query: (...args) => db.query(...args),
      checkReady: () => db.checkReady(),
      async withTransaction(fn) {
        return db.withTransaction(async (client) => {
          const out = await fn(client);
          if (crashAfterWrites) {
            const err = new Error('simulated crash before commit');
            err.code = 'SIMULATED_CRASH';
            throw err;
          }
          return out;
        });
      },
    };

    ({ app, mpesa, pos } = createTestApp({ appOptions: { db: crashingDb } }));
  });

  after(async () => {
    await db.closePool();
  });

  it('a crash between the log write and the transition leaves nothing behind', async () => {
    const { payment } = await startCharge(app, pos, { key: 'atomic-1' });
    const body = mpesa.buildCallback(payment.checkout_request_id);

    crashAfterWrites = true;
    const crashed = await postCallback(app, mpesa, body);
    assert.equal(crashed.status, 500, 'a crash must not look like success to Daraja');

    assert.equal(
      await countRows('callback_log'),
      0,
      'the log row and the transition roll back together'
    );

    const stuck = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [payment.id]);
    assert.equal(stuck.rows[0].status, 'pending');
  });

  it('the redelivered callback still settles the payment after a crash', async () => {
    const { sale, payment } = await startCharge(app, pos, { key: 'atomic-2' });
    const body = mpesa.buildCallback(payment.checkout_request_id);

    crashAfterWrites = true;
    await postCallback(app, mpesa, body);

    crashAfterWrites = false;
    const redelivered = await postCallback(app, mpesa, body);

    assert.equal(redelivered.status, 200);
    assert.equal(
      redelivered.body.applied,
      true,
      'the retry must settle, not be absorbed as a replay forever'
    );
    assert.equal(redelivered.body.status, 'paid');

    const settled = await db.query(
      `SELECT status, mpesa_receipt FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(settled.rows[0].status, 'paid');
    assert.ok(settled.rows[0].mpesa_receipt);
    assert.equal(pos.sales.get(sale.id).status, 'paid');

    assert.equal(await countRows('callback_log', "WHERE outcome = 'applied'"), 1);
    assert.equal(await countRows('payments'), 1, 'still exactly one charge');
  });

  it('at most one applied callback per payment, even for different bodies', async () => {
    const { payment } = await startCharge(app, pos, { key: 'atomic-3' });

    const success = await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));
    assert.equal(success.body.status, 'paid');

    const different = mpesa.buildCallback(payment.checkout_request_id, {
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
    });
    const late = await postCallback(app, mpesa, different);
    assert.equal(late.status, 409);

    const applied = await db.query(
      `SELECT count(*)::int AS n FROM payments.callback_log
       WHERE payment_id = $1 AND outcome = 'applied'`,
      [payment.id]
    );
    assert.equal(applied.rows[0].n, 1);
  });
});
