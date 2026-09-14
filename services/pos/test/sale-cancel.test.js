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

describe('sale cancel — frozen after awaiting_payment', () => {
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

  it('attendant can cancel a created sale', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'cancel-created',
      })
      .send(saleBody());
    assert.equal(created.status, 201);

    const cancelled = await request(app)
      .post(`/sales/${created.body.id}/cancel`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
  });

  it('attendant cannot cancel once awaiting_payment → 409', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'cancel-awaiting',
      })
      .send(saleBody());
    assert.equal(created.status, 201);

    const awaiting = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-x' });
    assert.equal(awaiting.status, 200);

    const cancel = await request(app)
      .post(`/sales/${created.body.id}/cancel`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send({});
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error, 'ILLEGAL_TRANSITION');

    // Sale is untouched — still awaiting_payment, ready for Payments.
    const read = await request(app)
      .get(`/sales/${created.body.id}`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA));
    assert.equal(read.body.status, 'awaiting_payment');
  });
});
