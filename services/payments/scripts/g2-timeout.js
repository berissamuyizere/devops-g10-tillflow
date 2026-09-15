#!/usr/bin/env node
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TEST_MSISDNS } = require('../../_shared/mpesa');

const POS = (process.env.POS_BASE_URL || 'http://127.0.0.1:18081').replace(/\/+$/, '');
const PAYMENTS = (process.env.PAYMENTS_BASE_URL || 'http://127.0.0.1:18082').replace(/\/+$/, '');
const POS_TOKEN = process.env.POS_SERVICE_TOKEN || 'dev-pos-token';
const TENANT_ID = process.env.TENANT_ID;
const ATTENDANT_ID = process.env.ATTENDANT_ID;
const SETTLE_WAIT_MS = Number(process.env.SETTLE_WAIT_MS || 15000);
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');

const steps = [];
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  steps.push({ check: name, ok, actual, expected });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

function xrayCompatibleTraceId() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(12).toString('hex');
}

async function main() {
  if (!TENANT_ID || !ATTENDANT_ID) {
    console.error('TENANT_ID and ATTENDANT_ID are required (a seeded active attendant in POS).');
    process.exit(2);
  }

  const traceId = xrayCompatibleTraceId();
  const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
  const trace = (extra = {}) => ({ traceparent, 'content-type': 'application/json', ...extra });

  console.log(`\nG2 timeout invariant (ADR-002: a timeout is never a failure)`);
  console.log(`  payer    ${TEST_MSISDNS.PUSH_TIMEOUT}  (fake adapter: stkPush throws MpesaTimeoutError)`);
  console.log(`  trace_id ${traceId}\n`);

  console.log('1. create a fresh sale');
  const saleRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: trace({
      'x-tenant-id': TENANT_ID,
      'x-user-id': ATTENDANT_ID,
      'x-role': 'attendant',
      'idempotency-key': `g2-timeout-sale-${randomUUID().slice(0, 8)}`,
    }),
    body: JSON.stringify({ lines: [{ description: 'Chai', quantity: 1, unit_price_minor: 5000 }] }),
  });
  const sale = await saleRes.json();
  check('sale created', saleRes.status, 201);

  console.log('2. charge the timeout payer');
  const chargeRes = await fetch(`${PAYMENTS}/internal/v1/charges`, {
    method: 'POST',
    headers: trace({
      'x-pos-token': POS_TOKEN,
      'idempotency-key': `g2-timeout-${randomUUID().slice(0, 8)}`,
    }),
    body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.PUSH_TIMEOUT }),
  });
  const payment = await chargeRes.json();
  check('charge accepted', chargeRes.status, 201);
  check('payment is pending, not failed', payment.status, 'pending');
  check('no failure_reason recorded', payment.failure_reason, null);
  check('correlation id survived the timeout', Boolean(payment.checkout_request_id), true);

  console.log(`3. wait ${SETTLE_WAIT_MS / 1000}s and re-read`);
  await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS));

  const after = await (
    await fetch(`${PAYMENTS}/internal/v1/payments/${payment.id}`, {
      headers: trace({ 'x-pos-token': POS_TOKEN }),
    })
  ).json();
  check('still pending after the wait', after.status, 'pending');
  check('never became failed', after.status === 'failed', false);
  check('never became timed_out without reconciliation', after.status === 'timed_out', false);

  const saleAfter = await (
    await fetch(`${POS}/sales/${sale.id}`, {
      headers: trace({
        'x-tenant-id': TENANT_ID,
        'x-user-id': ATTENDANT_ID,
        'x-role': 'attendant',
      }),
    })
  ).json();
  check('sale was not cancelled by the timeout', saleAfter.status === 'cancelled', false);
  check('sale was not marked paid', saleAfter.status === 'paid', false);

  const evidence = {
    captured_at: new Date().toISOString(),
    invariant: 'a Daraja timeout moves the payment to pending/unknown, never failed (ADR-002)',
    trace_id: traceId,
    xray_trace_id: `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`,
    traceparent,
    payer_msisdn: TEST_MSISDNS.PUSH_TIMEOUT,
    sale_id: sale.id,
    payment_id: payment.id,
    payment_status_immediately: payment.status,
    payment_status_after_wait: after.status,
    sale_status_after_wait: saleAfter.status,
    settle_wait_ms: SETTLE_WAIT_MS,
    checks: steps,
    passed: failures === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'g2-timeout.json');
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`evidence written to ${outFile}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('timeout invariant failed:', err);
  process.exit(2);
});
