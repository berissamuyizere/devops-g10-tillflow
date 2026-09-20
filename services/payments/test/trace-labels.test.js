const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
  require('@opentelemetry/sdk-trace-node');
const { trace, context } = require('@opentelemetry/api');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

const tracing = require('../src/tracing');
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

const tracer = trace.getTracer('test');

async function inSpan(name, fn) {
  const span = tracer.startSpan(name);
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } finally {
    span.end();
  }
}

function attrsOf(name) {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  return span ? span.attributes : null;
}

describe('money-path trace labels', () => {
  let app;
  let mpesa;
  let pos;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    exporter.reset();
    ({ app, mpesa, pos } = createTestApp({ appOptions: { metricsRefresh: false } }));
  });

  after(async () => {
    await db.closePool();
  });

  it('labels the charge with sale, payment and checkout ids', async () => {
    let payment;
    await inSpan('charge', async () => {
      const res = await startCharge(app, pos, { key: 't-charge' });
      payment = res.payment;
    });

    const a = attrsOf('charge');
    assert.ok(a, 'the charge span was recorded');
    assert.equal(a['sale.id'], payment.sale_id);
    assert.equal(a['payment.id'], payment.id);
    assert.equal(a['checkout_request_id'], payment.checkout_request_id);
  });

  it('keeps the correlation id on a timed-out push, so the trace can be followed', async () => {
    let payment;
    await inSpan('charge-timeout', async () => {
      const res = await startCharge(app, pos, {
        msisdn: TEST_MSISDNS.PUSH_TIMEOUT,
        key: 't-timeout',
      });
      payment = res.payment;
    });

    const a = attrsOf('charge-timeout');
    assert.equal(a['payment.id'], payment.id);
    assert.ok(a['checkout_request_id'], 'a timeout still carries the correlation id');
  });

  it('labels the callback with the payment and its outcome', async () => {
    const { payment } = await startCharge(app, pos, { key: 't-cb' });
    const body = mpesa.buildCallback(payment.checkout_request_id);

    await inSpan('callback', () => postCallback(app, mpesa, body));
    const applied = attrsOf('callback');
    assert.equal(applied['payment.id'], payment.id);
    assert.equal(applied['sale.id'], payment.sale_id);
    assert.equal(applied['callback.outcome'], 'applied');

    exporter.reset();
    await inSpan('callback-replay', () => postCallback(app, mpesa, body));
    assert.equal(attrsOf('callback-replay')['callback.outcome'], 'replay_noop');
  });

  it('labels a rejected callback with why it was rejected', async () => {
    const { payment } = await startCharge(app, pos, { key: 't-reject' });
    const forged = mpesa.buildCallback(payment.checkout_request_id, { amountMinor: 999900 });

    await inSpan('callback-rejected', () => postCallback(app, mpesa, forged));
    assert.equal(
      attrsOf('callback-rejected')['callback.outcome'],
      'rejected_amount_mismatch'
    );
  });

  it('labels reconcile with the payment being settled', async () => {
    const { payment } = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.NO_CALLBACK,
      key: 't-reconcile',
    });

    await inSpan('reconcile', () =>
      request(app)
        .post(`/internal/v1/payments/${payment.id}/reconcile`)
        .set({ 'x-pos-token': 'dev-pos-token' })
        .send({})
    );

    const a = attrsOf('reconcile');
    assert.equal(a['payment.id'], payment.id);
    assert.equal(a['checkout_request_id'], payment.checkout_request_id);
  });

  it('labels the payout with the ledger id', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const sale = pos.addSale({ tenant_id: tenantId });
    const { payment } = await startCharge(app, pos, { sale, key: 't-payout' });
    await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));

    let ledgerId;
    await inSpan('payout', async () => {
      const res = await request(app)
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
      ledgerId = res.body.id;
    });

    assert.equal(attrsOf('payout')['ledger.id'], ledgerId);
  });

  it('is a no-op without an active span rather than throwing', () => {
    assert.equal(tracing.annotate({ 'sale.id': 'x' }), false);
    assert.equal(tracing.annotatePayment(null), false);
    assert.equal(tracing.annotateLedger(undefined), false);
  });

  it('drops empty values instead of writing blank labels', async () => {
    await inSpan('partial', () => {
      tracing.annotatePayment({ id: 'p1', sale_id: null, checkout_request_id: '' });
    });
    const a = attrsOf('partial');
    assert.deepEqual(Object.keys(a), ['payment.id']);
  });
});
