const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { metrics: otelMetrics } = require('@opentelemetry/api');
const {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} = require('@opentelemetry/sdk-metrics');

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter,
  exportIntervalMillis: 60_000,
});
otelMetrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

const posMetrics = require('../src/metrics');
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

async function collect() {
  await reader.forceFlush();
  const batches = exporter.getMetrics();
  const out = new Map();
  for (const rm of batches) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        out.set(m.descriptor.name, m);
      }
    }
  }
  return out;
}

function createMemorySaleCache() {
  const store = new Map();
  return {
    enabled: true,
    async get(tenantId, saleId) {
      const key = `${tenantId}:${saleId}`;
      if (!store.has(key)) return { status: 'miss' };
      return { status: 'hit', value: store.get(key) };
    },
    async set(tenantId, saleId, sale) {
      store.set(`${tenantId}:${saleId}`, sale);
    },
    async invalidate(tenantId, saleId) {
      store.delete(`${tenantId}:${saleId}`);
    },
    async close() {},
    _store: store,
  };
}

describe('GET /sales/:id Valkey cache-aside', () => {
  let app;
  let fixtures;
  let saleCache;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    posMetrics.resetForTests();
    fixtures = await seedTenantPair();
    saleCache = createMemorySaleCache();
    app = createTestApp({ saleCache });
  });

  after(async () => {
    await db.closePool();
  });

  async function createSale() {
    const res = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': `cache-${Date.now()}`,
      })
      .send(saleBody());
    assert.equal(res.status, 201);
    return res.body;
  }

  it('records miss then hit on repeated reads', async () => {
    const sale = await createSale();
    const headers = attendantHeaders(fixtures.tenantA, fixtures.attendantA);

    const first = await request(app).get(`/sales/${sale.id}`).set(headers);
    assert.equal(first.status, 200);

    const second = await request(app).get(`/sales/${sale.id}`).set(headers);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, sale.id);

    const cacheMetric = (await collect()).get('pos_cache_requests_total');
    assert.ok(cacheMetric, 'pos_cache_requests_total is exported');
    const miss = cacheMetric.dataPoints.find((p) => p.attributes.result === 'miss');
    const hit = cacheMetric.dataPoints.find((p) => p.attributes.result === 'hit');
    assert.ok(miss && miss.value >= 1);
    assert.ok(hit && hit.value >= 1);
  });

  it('fail-open serves Postgres when cache errors', async () => {
    const sale = await createSale();
    saleCache.get = async () => ({ status: 'error' });
    saleCache.set = async () => {};

    const res = await request(app)
      .get(`/sales/${sale.id}`)
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, sale.id);

    const cacheMetric = (await collect()).get('pos_cache_requests_total');
    const error = cacheMetric.dataPoints.find((p) => p.attributes.result === 'error');
    assert.ok(error && error.value >= 1);
  });

  it('invalidates cache on cancel', async () => {
    const sale = await createSale();
    const headers = attendantHeaders(fixtures.tenantA, fixtures.attendantA);

    await request(app).get(`/sales/${sale.id}`).set(headers);
    assert.ok(saleCache._store.size >= 1);

    await request(app).post(`/sales/${sale.id}/cancel`).set(headers);
    assert.equal(saleCache._store.size, 0);
  });

  it('invalidates cache when Payments marks paid', async () => {
    const sale = await createSale();
    const headers = attendantHeaders(fixtures.tenantA, fixtures.attendantA);

    await request(app).get(`/sales/${sale.id}`).set(headers);
    assert.ok(saleCache._store.size >= 1);

    await request(app)
      .post(`/internal/v1/sales/${sale.id}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-cache-1' });
    await request(app)
      .post(`/internal/v1/sales/${sale.id}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-cache-1', paid_at: new Date().toISOString() });

    assert.equal(saleCache._store.size, 0);
  });

  it('does not cache internal Payments reads', async () => {
    const sale = await createSale();
    await request(app).get(`/internal/v1/sales/${sale.id}`).set(paymentsHeaders());
    assert.equal(saleCache._store.size, 0);
  });
});
