#!/usr/bin/env node
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../_shared/mpesa');

const POS = (process.env.POS_BASE_URL || 'http://127.0.0.1:18081').replace(/\/+$/, '');
const PAYMENTS = (process.env.PAYMENTS_BASE_URL || 'http://127.0.0.1:18082').replace(/\/+$/, '');
const POS_TOKEN = (process.env.POS_SERVICE_TOKEN || 'dev-pos-token').trim();
const CALLBACK_SECRET = (process.env.DARAJA_CALLBACK_SECRET || 'dev-callback-secret').trim();
const TENANT_ID = (process.env.TENANT_ID || '').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '').trim();
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');

const steps = [];
let failures = 0;

function xrayCompatibleTraceId() {
  const epochHex = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  return epochHex + randomBytes(12).toString('hex');
}

function xrayTraceId(w3cTraceId) {
  return `1-${w3cTraceId.slice(0, 8)}-${w3cTraceId.slice(8)}`;
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  steps.push({ check: name, ok, actual, expected });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  return ok;
}

async function main() {
  if (!TENANT_ID || !ATTENDANT_ID) {
    console.error('TENANT_ID and ATTENDANT_ID are required (a seeded active attendant in POS).');
    process.exit(2);
  }

  const traceId = xrayCompatibleTraceId();
  const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
  const saleKey = `g2-sale-${randomUUID().slice(0, 8)}`;
  const chargeKey = `g2-charge-${randomUUID().slice(0, 8)}`;
  const trace = (extra = {}) => ({ traceparent, 'content-type': 'application/json', ...extra });

  console.log(`\nG2 happy path\n  POS      ${POS}\n  Payments ${PAYMENTS}\n  trace_id ${traceId}\n`);

  const attendant = {
    'x-tenant-id': TENANT_ID,
    'x-user-id': ATTENDANT_ID,
    'x-role': 'attendant',
  };
  const saleBody = JSON.stringify({
    lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }],
  });

  console.log('1. create sale');
  const saleRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: trace({ ...attendant, 'idempotency-key': saleKey }),
    body: saleBody,
  });
  const sale = await saleRes.json();
  check('sale created', saleRes.status, 201);
  check('sale total_minor', sale.total_minor, 15000);

  console.log('2. replay sale key');
  const saleReplay = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: trace({ ...attendant, 'idempotency-key': saleKey }),
    body: saleBody,
  });
  const saleReplayBody = await saleReplay.json();
  check('sale replay is 200', saleReplay.status, 200);
  check('sale replay same id', saleReplayBody.id, sale.id);

  console.log('3. charge');
  const chargeRes = await fetch(`${PAYMENTS}/internal/v1/charges`, {
    method: 'POST',
    headers: trace({ 'x-pos-token': POS_TOKEN, 'idempotency-key': chargeKey }),
    body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS }),
  });
  const payment = await chargeRes.json();
  check('charge accepted', chargeRes.status, 201);
  check('payment pending', payment.status, 'pending');
  check('charged the POS amount', payment.amount_minor, 15000);

  console.log('4. replay charge key');
  const chargeReplay = await fetch(`${PAYMENTS}/internal/v1/charges`, {
    method: 'POST',
    headers: trace({ 'x-pos-token': POS_TOKEN, 'idempotency-key': chargeKey }),
    body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS }),
  });
  const chargeReplayBody = await chargeReplay.json();
  check('charge replay is 200', chargeReplay.status, 200);
  check('charge replay same id', chargeReplayBody.id, payment.id);
  check('charge replay flagged', chargeReplayBody.replay, true);

  console.log('5. callback');
  const mpesa = createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET });
  await mpesa.stkPush({
    shortcode: sale.mpesa_till || '174379',
    amountMinor: payment.amount_minor,
    msisdn: TEST_MSISDNS.SUCCESS,
    accountReference: sale.id,
    transactionDesc: 'TillFlow',
    callbackUrl: `${PAYMENTS}/payments/callback`,
  });
  const cbBody = mpesa.buildCallback(payment.checkout_request_id);
  if (!cbBody) {
    console.error('could not rebuild the callback — checkout_request_id did not match the fake');
    process.exit(2);
  }
  const signed = mpesa.signBody(cbBody, Date.now());
  const post = () =>
    fetch(`${PAYMENTS}/payments/callback`, {
      method: 'POST',
      headers: trace(signed.headers),
      body: signed.raw,
    });

  const cb1 = await post();
  const cb1Body = await cb1.json();
  check('callback applied', cb1.status, 200);
  check('payment paid', cb1Body.status, 'paid');

  console.log('6. replay callback');
  const cb2 = await post();
  const cb2Body = await cb2.json();
  check('callback replay is 200', cb2.status, 200);
  check('callback replay is a no-op', cb2Body.replay, true);

  console.log('7. final state');
  const finalSale = await (
    await fetch(`${POS}/sales/${sale.id}`, { headers: trace(attendant) })
  ).json();
  check('sale is paid', finalSale.status, 'paid');

  const finalPayment = await (
    await fetch(`${PAYMENTS}/internal/v1/payments/${payment.id}`, {
      headers: trace({ 'x-pos-token': POS_TOKEN }),
    })
  ).json();
  check('payment is paid', finalPayment.status, 'paid');
  check('POS sync recorded', Boolean(finalPayment.pos_paid_synced_at), true);

  const evidence = {
    captured_at: new Date().toISOString(),
    trace_id: traceId,
    xray_trace_id: xrayTraceId(traceId),
    traceparent,
    pos_base_url: POS,
    payments_base_url: PAYMENTS,
    mpesa_mode: 'fake',
    sale_id: sale.id,
    payment_id: payment.id,
    sale_idempotency_key: saleKey,
    charge_idempotency_key: chargeKey,
    mpesa_receipt: finalPayment.mpesa_receipt,
    checks: steps,
    passed: failures === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `g2-happy-path-${traceId.slice(0, 12)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`evidence written to ${outFile}`);
  console.log(`X-Ray trace id: ${xrayTraceId(traceId)}`);
  console.log(`W3C trace id  : ${traceId}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('happy path failed:', err);
  process.exit(2);
});
