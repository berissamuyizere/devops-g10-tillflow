const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  resetData,
  createTestApp,
  startCharge,
  countRows,
  TEST_MSISDNS,
} = require('./support/helpers');
const { createReconcileSweep } = require('../src/payments/reconcile-sweep');

async function statusOf(id) {
  const res = await db.query('SELECT * FROM payments.payments WHERE id = $1', [id]);
  return res.rows[0];
}

describe('reconciliation sweep', () => {
  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
  });

  function harness() {
    const { app, mpesa, pos } = createTestApp({
      appOptions: { reconcileSweep: false, metricsRefresh: false },
    });
    const sweep = createReconcileSweep(db, mpesa, pos, { minAgeMs: 0, batchSize: 50 });
    return { app, mpesa, pos, sweep };
  }

  it('settles a payment that never received a callback', async () => {
    const { app, pos, sweep } = harness();
    const { payment } = await startCharge(app, pos, { msisdn: TEST_MSISDNS.SUCCESS });
    assert.equal((await statusOf(payment.id)).status, 'pending');
    assert.equal(await countRows('callback_log'), 0, 'no callback has been delivered');

    const summary = await sweep.runOnce();

    assert.equal(summary.examined, 1);
    assert.equal(summary.changed, 1);
    assert.equal((await statusOf(payment.id)).status, 'paid');
    assert.equal(await countRows('callback_log'), 0, 'settled without any callback at all');
  });

  it('leaves an uncertain payment pending instead of failing it', async () => {
    const { app, pos, sweep } = harness();
    const { res } = await startCharge(app, pos, { msisdn: TEST_MSISDNS.PUSH_TIMEOUT });
    const paymentId = res.body.id;

    const before = await statusOf(paymentId);
    assert.equal(before.status, 'pending');

    const summary = await sweep.runOnce();

    assert.equal(summary.changed, 0);
    assert.equal(summary.errors, 0, 'a silent provider is not an error');
    assert.equal(summary.reasons.still_processing, 1);

    const after = await statusOf(paymentId);
    assert.equal(after.status, 'pending');
    assert.equal(after.failure_reason, null);
    assert.equal(after.timed_out_at, null);
  });

  it('ignores payments younger than the minimum age', async () => {
    const { app, pos, mpesa } = harness();
    await startCharge(app, pos, { msisdn: TEST_MSISDNS.SUCCESS });

    const patient = createReconcileSweep(db, mpesa, pos, { minAgeMs: 3600000 });
    const summary = await patient.runOnce();

    assert.equal(summary.examined, 0, 'a fresh payment is not yet overdue');
  });

  it('is safe to run twice over the same payment', async () => {
    const { app, pos, sweep } = harness();
    const { payment } = await startCharge(app, pos, { msisdn: TEST_MSISDNS.SUCCESS });

    const first = await sweep.runOnce();
    const settled = await statusOf(payment.id);
    const second = await sweep.runOnce();

    assert.equal(first.changed, 1);
    assert.equal(second.examined, 0, 'a settled payment is no longer due');

    const again = await statusOf(payment.id);
    assert.equal(again.status, 'paid');
    assert.equal(again.paid_at.toISOString(), settled.paid_at.toISOString(), 'paid_at must not move');
    assert.equal(again.mpesa_receipt, settled.mpesa_receipt, 'one receipt only');
  });

  it('two tasks sweeping at once settle the payment exactly once', async () => {
    const { app, pos, mpesa } = harness();
    const { payment } = await startCharge(app, pos, { msisdn: TEST_MSISDNS.SUCCESS });

    const taskA = createReconcileSweep(db, mpesa, pos, { minAgeMs: 0 });
    const taskB = createReconcileSweep(db, mpesa, pos, { minAgeMs: 0 });

    const [a, b] = await Promise.all([taskA.runOnce(), taskB.runOnce()]);
    const settled = await statusOf(payment.id);

    assert.equal(settled.status, 'paid');
    assert.equal(
      a.changed + b.changed,
      1,
      'exactly one sweep may transition the payment, whichever wins the row lock'
    );
    assert.equal(await countRows('payments', 'WHERE sale_id = $1', [settled.sale_id]), 1);
  });
});
