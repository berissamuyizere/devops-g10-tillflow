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

describe('cross-tenant sale reads', () => {
  let app;
  let fixtures;
  let saleId;

  before(async () => {
    app = createTestApp();
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    fixtures = await seedTenantPair();
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'cross-tenant-1',
      })
      .send(saleBody());
    assert.equal(created.status, 201);
    saleId = created.body.id;
  });

  it('own tenant can read the sale', async () => {
    const res = await request(app)
      .get(`/sales/${saleId}`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, saleId);
  });

  it('other tenant gets 404 (not an empty leak)', async () => {
    const res = await request(app)
      .get(`/sales/${saleId}`)
      .set(attendantHeaders(fixtures.tenantB, fixtures.attendantB));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  });
});
