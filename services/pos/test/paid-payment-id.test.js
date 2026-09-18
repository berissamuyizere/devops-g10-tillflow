const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  seedTenantPair,
  attendantHeaders,
  paymentsHeaders,
  saleBody,
  createTestApp,
} = require('./support/helpers');

describe('POST /internal/v1/sales/:id/paid payment_id', () => {
  let app;
  let fixtures;

  before(async () => {
    app = createTestApp();
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    fixtures = await seedTenantPair();
  });

  async function saleAwaitingPayment(key) {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': key,
      })
      .send(saleBody());
    assert.equal(created.status, 201);
    const awaiting = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1' });
    assert.equal(awaiting.status, 200);
    return created.body.id;
  }

  it('missing payment_id → 400', async () => {
    const saleId = await saleAwaitingPayment('paid-missing-pid');
    const res = await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ paid_at: '2026-09-10T10:00:00.000Z' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'VALIDATION');
  });

  it('same payment_id → 200 replay', async () => {
    const saleId = await saleAwaitingPayment('paid-same-pid');
    const first = await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1', paid_at: '2026-09-10T10:00:00.000Z' });
    assert.equal(first.status, 200);
    assert.equal(first.body.payment_id, 'pay-1');

    const second = await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1', paid_at: '2026-09-11T10:00:00.000Z' });
    assert.equal(second.status, 200);
    assert.equal(second.body.payment_id, 'pay-1');
    assert.equal(new Date(second.body.paid_at).toISOString(), '2026-09-10T10:00:00.000Z');
  });

  it('different payment_id → 409', async () => {
    const saleId = await saleAwaitingPayment('paid-mismatch-pid');
    const first = await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1', paid_at: '2026-09-10T10:00:00.000Z' });
    assert.equal(first.status, 200);

    const second = await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-other', paid_at: '2026-09-10T10:00:00.000Z' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'PAYMENT_ID_MISMATCH');

    const stored = await db.query(`SELECT payment_id, status FROM pos.sales WHERE id = $1`, [
      saleId,
    ]);
    assert.equal(stored.rows[0].payment_id, 'pay-1');
    assert.equal(stored.rows[0].status, 'paid');
  });
});
