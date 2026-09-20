const { metrics } = require('@opentelemetry/api');

const METER_NAME = 'tillflow.pos';

let meter;
let saleWritesTotal;
let saleWriteLatencyMs;
let salesPaidTotal;

function getMeter() {
  if (!meter) meter = metrics.getMeter(METER_NAME);
  return meter;
}

function init() {
  const m = getMeter();

  saleWritesTotal = m.createCounter('pos_sale_writes_total', {
    description: 'POST /sales outcomes',
  });

  saleWriteLatencyMs = m.createHistogram('pos_sale_write_latency_ms', {
    description: 'POST /sales handler latency',
    unit: 'ms',
  });

  salesPaidTotal = m.createCounter('pos_sales_paid_total', {
    description: 'Sales marked paid (first transition only)',
  });
}

function ensure() {
  if (!saleWritesTotal) init();
}

function recordSaleWrite(outcome, latencyMs) {
  ensure();
  saleWritesTotal.add(1, { outcome });
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    saleWriteLatencyMs.record(latencyMs);
  }
}

function recordSalePaid() {
  ensure();
  salesPaidTotal.add(1);
}

function resetForTests() {
  meter = undefined;
  saleWritesTotal = undefined;
  saleWriteLatencyMs = undefined;
  salesPaidTotal = undefined;
}

module.exports = {
  METER_NAME,
  recordSaleWrite,
  recordSalePaid,
  resetForTests,
};
