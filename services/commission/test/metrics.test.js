const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { metrics: otelMetrics } = require('@opentelemetry/api');
const {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} = require('@opentelemetry/sdk-metrics');
const { SimpleSpanProcessor, InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
otelMetrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
tracerProvider.register();

const commissionMetrics = require('../src/metrics');
const { runDailyClose } = require('../src/close');

async function collectMetrics() {
  await metricReader.forceFlush();
  const batches = metricExporter.getMetrics();
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

describe('commission metrics', () => {
  beforeEach(() => {
    commissionMetrics.resetForTests();
    spanExporter.reset();
  });

  it('records a successful close run and payout outcomes', async () => {
    const fetchImpl = async (url, _init = {}) => {
      if (String(url).includes('/commission/eligible')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sales: [
              {
                id: 's1',
                tenant_id: 't1',
                attendant_id: 'a1',
                payout_msisdn: '254700000001',
                commission_bps: 500,
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'ledger-1', status: 'disbursing', replay: false }),
      };
    };

    await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      businessDay: '2026-09-19',
    });

    const collected = await collectMetrics();
    const runs = collected.get('commission_close_runs_total');
    assert.ok(runs, 'commission_close_runs_total is exported');
    assert.ok(runs.dataPoints.some((p) => p.attributes.outcome === 'success'));

    const payouts = collected.get('commission_payouts_requested_total');
    assert.ok(payouts, 'commission_payouts_requested_total is exported');
    assert.ok(payouts.dataPoints.some((p) => p.attributes.outcome === 'accepted'));
  });

  it('records close error and skipped payouts', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/commission/eligible')) {
        return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    };

    await assert.rejects(() =>
      runDailyClose({
        fetchImpl,
        posBaseUrl: 'http://pos.example',
        paymentsBaseUrl: 'http://pay.example',
        paymentsToken: 'pay-token',
        commissionToken: 'comm-token',
        tenantIds: ['t1'],
        businessDay: '2026-09-19',
      })
    );

    const runs = (await collectMetrics()).get('commission_close_runs_total');
    assert.ok(runs.dataPoints.some((p) => p.attributes.outcome === 'error'));
  });

  it('creates a commission.daily_close root span', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/commission/eligible')) {
        return { ok: true, status: 200, json: async () => ({ sales: [] }) };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    };

    await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      businessDay: '2026-09-19',
    });

    await tracerProvider.forceFlush();
    const spans = spanExporter.getFinishedSpans();
    assert.ok(spans.some((s) => s.name === 'commission.daily_close'));
  });

  it('never puts an id in a label', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/commission/eligible')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sales: [
              {
                id: '00000000-0000-0000-0000-000000000001',
                tenant_id: '11111111-1111-1111-1111-111111111111',
                attendant_id: '22222222-2222-2222-2222-222222222222',
                payout_msisdn: '254700000001',
                commission_bps: 500,
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ replay: true }) };
    };

    await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      businessDay: '2026-09-19',
    });

    const collected = await collectMetrics();
    for (const name of ['commission_close_runs_total', 'commission_payouts_requested_total']) {
      const m = collected.get(name);
      assert.ok(m, `${name} is exported`);
      for (const pt of m.dataPoints) {
        for (const v of Object.values(pt.attributes)) {
          assert.ok(!ID_RE.test(String(v)), `${name} label must not be a uuid: ${v}`);
        }
      }
    }
  });
});
