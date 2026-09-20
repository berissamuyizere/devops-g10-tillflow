const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  seedTenantPair,
  attendantHeaders,
  saleBody,
  createTestApp,
} = require('./support/helpers');

describe('POST /sales/:id/pay', () => {
  let app;
  let fixtures;
  let chargeCalls;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    fixtures = await seedTenantPair();
    chargeCalls = [];
    app = createTestApp({
      paymentsClient: {
        startCharge: async ({ saleId, msisdn, idempotencyKey }) => {
          chargeCalls.push({ saleId, msisdn, idempotencyKey });
          return {
            payment: {
              id: 'pay-test-1',
              sale_id: saleId,
              status: 'pending',
              msisdn,
            },
            replay: false,
          };
        },
      },
    });
  });

  async function createSale() {
    const res = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': `pay-${Date.now()}`,
      })
      .send(saleBody());
    assert.equal(res.status, 201);
    return res.body;
  }

  it('requires Idempotency-Key', async () => {
    const sale = await createSale();
    const res = await request(app)
      .post(`/sales/${sale.id}/pay`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send({ msisdn: '254700000001' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'MISSING_IDEMPOTENCY_KEY');
  });

  it('starts a charge via Payments internal API', async () => {
    const sale = await createSale();
    const res = await request(app)
      .post(`/sales/${sale.id}/pay`)
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'charge-1',
      })
      .send({ msisdn: '254700000001' });

    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'pending');
    assert.equal(chargeCalls.length, 1);
    assert.equal(chargeCalls[0].saleId, sale.id);
    assert.equal(chargeCalls[0].msisdn, '254700000001');
    assert.equal(chargeCalls[0].idempotencyKey, 'charge-1');
  });

  it('returns 404 for cross-tenant sale', async () => {
    const sale = await createSale();
    const res = await request(app)
      .post(`/sales/${sale.id}/pay`)
      .set({
        ...attendantHeaders(fixtures.tenantB, fixtures.attendantB),
        'idempotency-key': 'charge-x',
      })
      .send({ msisdn: '254700000002' });
    assert.equal(res.status, 404);
    assert.equal(chargeCalls.length, 0);
  });

  it('returns 409 when sale is already paid', async () => {
    const sale = await createSale();
    await db.query(`UPDATE pos.sales SET status = 'paid' WHERE id = $1`, [sale.id]);

    const res = await request(app)
      .post(`/sales/${sale.id}/pay`)
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'charge-paid',
      })
      .send({ msisdn: '254700000001' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'sale_not_chargeable');
    assert.equal(chargeCalls.length, 0);
  });
});
