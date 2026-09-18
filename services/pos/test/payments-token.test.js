const { describe, it, before, beforeEach, afterEach } = require('node:test');
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

describe('PAYMENTS_SERVICE_TOKEN fail-closed', () => {
  let app;
  let fixtures;
  const original = process.env.PAYMENTS_SERVICE_TOKEN;

  before(async () => {
    app = createTestApp();
    await db.checkReady();
  });

  beforeEach(async () => {
    process.env.PAYMENTS_SERVICE_TOKEN = original || 'dev-payments-token';
    await resetData();
    fixtures = await seedTenantPair();
  });

  afterEach(() => {
    process.env.PAYMENTS_SERVICE_TOKEN = original || 'dev-payments-token';
  });

  it('missing PAYMENTS_SERVICE_TOKEN → 500, request is rejected', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'token-missing',
      })
      .send(saleBody());
    assert.equal(created.status, 201);

    delete process.env.PAYMENTS_SERVICE_TOKEN;
    const res = await request(app)
      .post(`/internal/v1/sales/${created.body.id}/paid`)
      .set({ 'x-payments-token': 'dev-payments-token' })
      .send({ payment_id: 'pay-1' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'misconfigured');
  });

  it('empty PAYMENTS_SERVICE_TOKEN → 500', async () => {
    process.env.PAYMENTS_SERVICE_TOKEN = '   ';
    const res = await request(app)
      .get('/internal/v1/sales/00000000-0000-0000-0000-000000000001')
      .set({ 'x-payments-token': 'dev-payments-token' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'misconfigured');
  });

  it('wrong token is still 401 when env is set', async () => {
    const res = await request(app)
      .get('/internal/v1/sales/00000000-0000-0000-0000-000000000001')
      .set({ 'x-payments-token': 'not-the-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'unauthorized');
  });
});
