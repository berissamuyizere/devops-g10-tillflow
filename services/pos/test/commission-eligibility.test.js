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
const { toEatDate } = require('../src/commission/eligibility');

describe('commission eligibility — unpaid sales excluded', () => {
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

  it('unpaid sales are not eligible; paid on the EAT day are', async () => {
    const unpaid = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'elig-unpaid',
      })
      .send(saleBody());
    assert.equal(unpaid.status, 201);

    const paying = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'elig-paid',
      })
      .send(saleBody());
    assert.equal(paying.status, 201);

    const awaiting = await request(app)
      .post(`/internal/v1/sales/${paying.body.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1' });
    assert.equal(awaiting.status, 200);
    assert.equal(awaiting.body.status, 'awaiting_payment');

    const paidAt = new Date();
    const paid = await request(app)
      .post(`/internal/v1/sales/${paying.body.id}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-1', paid_at: paidAt.toISOString() });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'paid');

    const businessDay = toEatDate(paidAt);
    const eligible = await request(app)
      .get('/internal/v1/commission/eligible')
      .query({ tenant_id: fixtures.tenantA, business_day: businessDay })
      .set(paymentsHeaders());

    assert.equal(eligible.status, 200);
    assert.equal(eligible.body.sales.length, 1);
    assert.equal(eligible.body.sales[0].id, paying.body.id);
    assert.ok(!eligible.body.sales.some((s) => s.id === unpaid.body.id));
  });

  it('only Payments can move sale to awaiting_payment / paid', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'payments-only',
      })
      .send(saleBody());
    assert.equal(created.status, 201);

    const forbidden = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/awaiting-payment`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send({});
    assert.equal(forbidden.status, 401);

    const ok = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({});
    assert.equal(ok.status, 200);
  });

  it('paid replay is a no-op', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'paid-replay',
      })
      .send(saleBody());

    await request(app)
      .post(`/internal/v1/sales/${created.body.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({});

    const firstPaidAt = '2026-09-10T10:00:00.000Z';
    const first = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/paid`)
      .set(paymentsHeaders())
      .send({ paid_at: firstPaidAt });
    assert.equal(first.status, 200);

    const second = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/paid`)
      .set(paymentsHeaders())
      .send({ paid_at: '2026-09-11T10:00:00.000Z' });
    assert.equal(second.status, 200);
    assert.equal(new Date(second.body.paid_at).toISOString(), new Date(firstPaidAt).toISOString());
    assert.equal(second.body.total_minor, first.body.total_minor);
  });
});
