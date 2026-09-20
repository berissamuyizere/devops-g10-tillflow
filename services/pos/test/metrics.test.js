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

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('pos metrics', () => {
  let app;
  let fixtures;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    posMetrics.resetForTests();
    app = createTestApp();
    fixtures = await seedTenantPair();
  });

  after(async () => {
    await db.closePool();
  });

  it('counts a created sale and records write latency', async () => {
    const res = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'metrics-created',
      })
      .send(saleBody());
    assert.equal(res.status, 201);

    const collected = await collect();
    const writes = collected.get('pos_sale_writes_total');
    assert.ok(writes, 'pos_sale_writes_total is exported');
    const created = writes.dataPoints.find((p) => p.attributes.outcome === 'created');
    assert.ok(created && created.value >= 1);

    const latency = collected.get('pos_sale_write_latency_ms');
    assert.ok(latency, 'pos_sale_write_latency_ms is exported');
    assert.ok(latency.dataPoints.some((p) => p.value.count >= 1));
  });

  it('counts an idempotent replay as replay', async () => {
    const headers = {
      ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
      'idempotency-key': 'metrics-replay',
    };
    await request(app).post('/sales').set(headers).send(saleBody());
    await request(app).post('/sales').set(headers).send(saleBody());

    const writes = (await collect()).get('pos_sale_writes_total');
    const replay = writes.dataPoints.find((p) => p.attributes.outcome === 'replay');
    assert.ok(replay && replay.value >= 1);
  });

  it('counts validation failures as rejected', async () => {
    await request(app)
      .post('/sales')
      .set(attendantHeaders(fixtures.tenantA, fixtures.attendantA))
      .send(saleBody());

    const writes = (await collect()).get('pos_sale_writes_total');
    const rejected = writes.dataPoints.find((p) => p.attributes.outcome === 'rejected');
    assert.ok(rejected && rejected.value >= 1);
  });

  it('counts markPaid transitions', async () => {
    const created = await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'metrics-paid',
      })
      .send(saleBody());
    const saleId = created.body.id;

    await request(app)
      .post(`/internal/v1/sales/${saleId}/awaiting-payment`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-metrics-1' });

    await request(app)
      .post(`/internal/v1/sales/${saleId}/paid`)
      .set(paymentsHeaders())
      .send({ payment_id: 'pay-metrics-1', paid_at: new Date().toISOString() });

    const paid = (await collect()).get('pos_sales_paid_total');
    assert.ok(paid, 'pos_sales_paid_total is exported');
    assert.ok(paid.dataPoints.some((p) => p.value >= 1));
  });

  it('never puts an id in a label', async () => {
    await request(app)
      .post('/sales')
      .set({
        ...attendantHeaders(fixtures.tenantA, fixtures.attendantA),
        'idempotency-key': 'metrics-noids',
      })
      .send(saleBody());

    const collected = await collect();
    const allowed = {
      pos_sale_writes_total: ['outcome'],
      pos_sale_write_latency_ms: [],
      pos_sales_paid_total: [],
    };

    for (const [name, keys] of Object.entries(allowed)) {
      const m = collected.get(name);
      assert.ok(m, `${name} is exported`);
      for (const pt of m.dataPoints) {
        assert.deepEqual(Object.keys(pt.attributes).sort(), [...keys].sort());
        for (const v of Object.values(pt.attributes)) {
          assert.ok(!ID_RE.test(String(v)), `${name} label must not be a uuid: ${v}`);
        }
      }
    }
  });
});
