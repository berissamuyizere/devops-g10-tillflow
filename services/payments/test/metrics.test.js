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

const metrics = require('../src/metrics');
const {
  db,
  request,
  randomUUID,
  resetData,
  createTestApp,
  commissionHeaders,
  postCallback,
  startCharge,
  TEST_MSISDNS,
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

describe('payments metrics', () => {
  let app;
  let mpesa;
  let pos;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    metrics.resetForTests();
    ({ app, mpesa, pos } = createTestApp({ appOptions: { metricsRefresh: false } }));
  });

  after(async () => {
    await db.closePool();
  });

  it('counts an accepted STK command', async () => {
    await startCharge(app, pos, { key: 'm-ok' });
    const m = (await collect()).get('payments_commands_total');
    assert.ok(m, 'payments_commands_total is exported');
    const pt = m.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'accepted'
    );
    assert.ok(pt && pt.value >= 1);
  });

  it('counts a timed-out STK command as timeout, not rejected', async () => {
    await startCharge(app, pos, { msisdn: TEST_MSISDNS.PUSH_TIMEOUT, key: 'm-timeout' });
    const m = (await collect()).get('payments_commands_total');
    const timeout = m.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'timeout'
    );
    assert.ok(timeout && timeout.value >= 1, 'a timeout is its own outcome');
    const rejected = m.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'rejected'
    );
    assert.ok(!rejected || rejected.value === 0, 'a timeout must not count as rejected');
  });

  it('counts callbacks by outcome and records latency', async () => {
    const { payment } = await startCharge(app, pos, { key: 'm-cb' });
    const body = mpesa.buildCallback(payment.checkout_request_id);
    await postCallback(app, mpesa, body);
    await postCallback(app, mpesa, body);

    const collected = await collect();
    const counts = collected.get('payments_callbacks_total');
    assert.ok(counts, 'payments_callbacks_total is exported');

    const applied = counts.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'applied'
    );
    const replay = counts.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'replay'
    );
    assert.ok(applied && applied.value >= 1);
    assert.ok(replay && replay.value >= 1, 'a replayed callback is counted as replay');

    const latency = collected.get('payments_callback_latency_ms');
    assert.ok(latency, 'payments_callback_latency_ms is exported');
    const pt = latency.dataPoints.find((p) => p.attributes.kind === 'stk');
    assert.ok(pt && pt.value.count >= 1, 'latency is recorded for the SLI');
  });

  it('counts a rejected callback', async () => {
    const { payment } = await startCharge(app, pos, { key: 'm-reject' });
    const forged = mpesa.buildCallback(payment.checkout_request_id, { amountMinor: 999900 });
    await postCallback(app, mpesa, forged);

    const counts = (await collect()).get('payments_callbacks_total');
    const rejected = counts.dataPoints.find(
      (p) => p.attributes.kind === 'stk' && p.attributes.outcome === 'rejected'
    );
    assert.ok(rejected && rejected.value >= 1);
  });

  it('reports the oldest pending age and payout statuses from the database', async () => {
    const { payment } = await startCharge(app, pos, { key: 'm-gauge' });
    assert.equal(payment.status, 'pending');

    const snapshot = await metrics.refreshFromDb(db);
    assert.ok(snapshot.pending.payment >= 0, 'oldest pending payment age is observed');

    const collected = await collect();
    const age = collected.get('payments_oldest_pending_age_seconds');
    assert.ok(age, 'payments_oldest_pending_age_seconds is exported');
    assert.ok(age.dataPoints.some((p) => p.attributes.kind === 'payment'));
    assert.ok(age.dataPoints.some((p) => p.attributes.kind === 'payout'));

    const payouts = collected.get('payouts_by_status');
    assert.ok(payouts, 'payouts_by_status is exported');
    assert.ok(payouts.dataPoints.some((p) => p.attributes.status === 'disbursed'));
  });

  it('counts b2c commands and tracks payout status', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const sale = pos.addSale({ tenant_id: tenantId });
    const { payment } = await startCharge(app, pos, { sale, key: 'm-b2c' });
    await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));

    await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:2026-09-21` }))
      .send({
        tenant_id: tenantId,
        agent_id: agentId,
        period: '2026-09-21',
        msisdn: '254700000000',
        commission_bps: 500,
        sales: [sale.id],
      });

    await metrics.refreshFromDb(db);
    const collected = await collect();

    const cmds = collected.get('payments_commands_total');
    const b2c = cmds.dataPoints.find(
      (p) => p.attributes.kind === 'b2c' && p.attributes.outcome === 'accepted'
    );
    assert.ok(b2c && b2c.value >= 1);

    const payouts = collected.get('payouts_by_status');
    const disbursing = payouts.dataPoints.find((p) => p.attributes.status === 'disbursing');
    assert.ok(disbursing && disbursing.value >= 1);
  });

  it('never puts an id in a label', async () => {
    const { payment } = await startCharge(app, pos, { key: 'm-noids' });
    await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));
    await metrics.refreshFromDb(db);

    const collected = await collect();
    const allowed = {
      payments_commands_total: ['kind', 'outcome'],
      payments_callback_latency_ms: ['kind'],
      payments_callbacks_total: ['kind', 'outcome'],
      payments_oldest_pending_age_seconds: ['kind'],
      payouts_by_status: ['status'],
    };

    for (const [name, keys] of Object.entries(allowed)) {
      const m = collected.get(name);
      assert.ok(m, `${name} is exported`);
      for (const pt of m.dataPoints) {
        assert.deepEqual(
          Object.keys(pt.attributes).sort(),
          [...keys].sort(),
          `${name} carries only ${keys.join(', ')}`
        );
        for (const v of Object.values(pt.attributes)) {
          assert.ok(!ID_RE.test(String(v)), `${name} label must not be a uuid: ${v}`);
          assert.ok(
            !/^ws_CO|^tillflow-/.test(String(v)),
            `${name} label must not be a correlation id: ${v}`
          );
        }
      }
    }
  });
});
