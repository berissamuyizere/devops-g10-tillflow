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

describe('POST /sales idempotency', () => {
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

  it('missing Idempotency-Key → 400', async () => {
    const res = await request(app)
      .post('/sales')
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send(saleBody());

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'MISSING_IDEMPOTENCY_KEY');
  });

  it('same key + same body → returns original sale (no second row)', async () => {
    const headers = {
      ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
      'idempotency-key': 'sale-key-1',
    };

    const first = await request(app).post('/sales').set(headers).send(saleBody());
    assert.equal(first.status, 201);
    assert.equal(first.body.total_minor, 15000);
    assert.equal(first.body.status, 'created');

    const second = await request(app).post('/sales').set(headers).send(saleBody());
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);

    const count = await db.query(
      `SELECT count(*)::int AS n FROM pos.sales WHERE tenant_id = $1`,
      [fixtures.tenantA]
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('same key + different body → 409', async () => {
    const headers = {
      ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
      'idempotency-key': 'sale-key-2',
    };

    const first = await request(app).post('/sales').set(headers).send(saleBody());
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/sales')
      .set(headers)
      .send(
        saleBody({
          lines: [{ description: 'Coffee', quantity: 1, unit_price_minor: 10000 }],
        })
      );

    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'IDEMPOTENCY_CONFLICT');
  });

  it('two parallel POST /sales with the same key → one row, 201+200, never 500', async () => {
    const headers = {
      ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
      'idempotency-key': 'sale-key-race',
    };
    const body = saleBody();

    const [first, second] = await Promise.all([
      request(app).post('/sales').set(headers).send(body),
      request(app).post('/sales').set(headers).send(body),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.equal(first.status >= 500, false, `first was ${first.status} ${JSON.stringify(first.body)}`);
    assert.equal(second.status >= 500, false, `second was ${second.status} ${JSON.stringify(second.body)}`);
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(first.body.id, second.body.id);

    const count = await db.query(
      `SELECT count(*)::int AS n FROM pos.sales WHERE tenant_id = $1 AND idempotency_key = $2`,
      [fixtures.tenantA, 'sale-key-race']
    );
    assert.equal(count.rows[0].n, 1);
  });
});
