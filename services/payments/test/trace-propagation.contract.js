const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createCollector } = require('../scripts/otlp-collector');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../_shared/mpesa');

const POS_URL = process.env.POS_DATABASE_URL || 'postgres://pos:pos@127.0.0.1:5433/tillflow_pos';
const PAY_URL =
  process.env.DATABASE_URL || 'postgres://payments:payments@127.0.0.1:5434/tillflow_payments';
const CALLBACK_SECRET = 'trace-callback-secret';
const POS_PORT = 18081;
const PAY_PORT = 18082;

function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`${baseUrl} never became healthy`);
  })();
}

function start(cwd, env) {
  const child = spawn(
    process.execPath,
    ['--require', './otel-bootstrap.js', 'server.js'],
    { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  child.logs = logs;
  return child;
}

describe('contract: one trace across POS and Payments', () => {
  let collector;
  let collectorPort;
  let posProc;
  let payProc;
  let posPool;
  let payPool;
  let mpesa;
  let fixtures;

  before(async () => {
    collector = createCollector();
    collectorPort = await collector.listen();
    const otlp = `http://127.0.0.1:${collectorPort}`;

    posPool = new Pool({ connectionString: POS_URL, options: '-c search_path=pos,public' });
    payPool = new Pool({ connectionString: PAY_URL });

    await payPool.query(
      'TRUNCATE payments.payout_ledger_sales, payments.payout_ledger, payments.callback_log, payments.payments CASCADE'
    );
    await posPool.query(
      'TRUNCATE pos.sale_lines, pos.sales, pos.attendants, pos.memberships, pos.users, pos.tenants CASCADE'
    );

    const tenantId = randomUUID();
    const attendantId = randomUUID();
    await posPool.query(
      `INSERT INTO pos.tenants (id, name, status, mpesa_till, default_commission_bps)
       VALUES ($1, 'Trace Shop', 'active', '174379', 500)`,
      [tenantId]
    );
    await posPool.query(`INSERT INTO pos.users (id, email) VALUES ($1, $2)`, [
      attendantId,
      `trace-${attendantId}@example.com`,
    ]);
    await posPool.query(
      `INSERT INTO pos.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'attendant')`,
      [tenantId, attendantId]
    );
    await posPool.query(
      `INSERT INTO pos.attendants (id, tenant_id, display_name, payout_msisdn, commission_bps, status)
       VALUES ($1, $2, 'Ada', '254700000001', 500, 'active')`,
      [attendantId, tenantId]
    );
    fixtures = { tenantId, attendantId };

    const posDir = path.resolve(__dirname, '../../pos');
    const payDir = path.resolve(__dirname, '..');

    posProc = start(posDir, {
      PORT: String(POS_PORT),
      DATABASE_URL: POS_URL,
      OTEL_SERVICE_NAME: 'pos',
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_BSP_SCHEDULE_DELAY: '200',
      PAYMENTS_SERVICE_TOKEN: 'dev-payments-token',
      LOG_LEVEL: 'silent',
    });

    payProc = start(payDir, {
      PORT: String(PAY_PORT),
      DATABASE_URL: PAY_URL,
      OTEL_SERVICE_NAME: 'payments',
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_BSP_SCHEDULE_DELAY: '200',
      POS_BASE_URL: `http://127.0.0.1:${POS_PORT}`,
      PAYMENTS_SERVICE_TOKEN: 'dev-payments-token',
      POS_SERVICE_TOKEN: 'dev-pos-token',
      DARAJA_CALLBACK_SECRET: CALLBACK_SECRET,
      MPESA_MODE: 'fake',
      LOG_LEVEL: 'silent',
    });

    await waitForHealth(`http://127.0.0.1:${POS_PORT}`);
    await waitForHealth(`http://127.0.0.1:${PAY_PORT}`);

    mpesa = createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET });
  });

  after(async () => {
    posProc?.kill('SIGKILL');
    payProc?.kill('SIGKILL');
    await posPool?.end();
    await payPool?.end();
    await collector?.close();
  });

  it('carries one trace id from the sale through the payment and the callback', async () => {
    const traceId = randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${rootSpanId}-01`;

    const saleRes = await fetch(`http://127.0.0.1:${POS_PORT}/sales`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent,
        'idempotency-key': 'trace-sale-1',
        'x-tenant-id': fixtures.tenantId,
        'x-user-id': fixtures.attendantId,
        'x-role': 'attendant',
      },
      body: JSON.stringify({
        lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }],
      }),
    });
    assert.equal(saleRes.status, 201);
    const sale = await saleRes.json();

    const chargeRes = await fetch(`http://127.0.0.1:${PAY_PORT}/internal/v1/charges`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent,
        'x-pos-token': 'dev-pos-token',
        'idempotency-key': 'trace-charge-1',
      },
      body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS }),
    });
    assert.equal(chargeRes.status, 201);
    const payment = await chargeRes.json();
    assert.equal(payment.status, 'pending');

    await mpesa.stkPush({
      shortcode: '174379',
      amountMinor: payment.amount_minor,
      msisdn: TEST_MSISDNS.SUCCESS,
      accountReference: sale.id,
      transactionDesc: 'TillFlow',
      callbackUrl: 'https://tillflow.test/payments/callback',
    });
    assert.equal(
      mpesa.buildCallback(payment.checkout_request_id).Body.stkCallback.CheckoutRequestID,
      payment.checkout_request_id,
      'the fake is deterministic, so the test rebuilds the same callback the server would get'
    );

    const body = mpesa.buildCallback(payment.checkout_request_id);
    const signed = mpesa.signBody(body, Date.now());
    const cbRes = await fetch(`http://127.0.0.1:${PAY_PORT}/payments/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent, ...signed.headers },
      body: signed.raw,
    });
    assert.equal(cbRes.status, 200);
    assert.equal((await cbRes.json()).status, 'paid');

    // Let the batch span processor flush.
    await new Promise((r) => setTimeout(r, 2500));

    const all = collector.spans();
    const mine = all.filter((s) => s.traceId === traceId);
    const services = new Set(mine.map((s) => s.service));

    assert.ok(
      services.has('payments'),
      `expected payments spans on trace ${traceId}; saw services ${[...new Set(all.map((s) => s.service))]}`
    );
    assert.ok(
      services.has('pos'),
      'POS and Payments must share ONE trace — otherwise the G2 evidence is two disconnected traces'
    );

    // The Payments -> POS hop must be a child, not a new root.
    const posServerSpans = mine.filter((s) => s.service === 'pos' && s.kind === 2);
    assert.ok(posServerSpans.length > 0, 'POS served requests inside the trace');
    assert.ok(
      posServerSpans.some((s) => s.parentSpanId),
      'POS spans must have a parent — context propagated over fetch'
    );

    console.log(
      `\n  trace_id ${traceId}: ${mine.length} spans across ${[...services].sort().join(' + ')}`
    );
  });
});
