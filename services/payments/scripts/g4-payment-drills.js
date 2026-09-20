#!/usr/bin/env node
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const signature = require('../../_shared/mpesa/signature');

const API = (process.env.API_URL || '').replace(/\/+$/, '');
const CALLBACK_BASE = (process.env.CALLBACK_BASE_URL || API).replace(/\/+$/, '');
const INTERNAL_BASE = (process.env.INTERNAL_BASE_URL || API).replace(/\/+$/, '');
const POS_TOKEN = (process.env.POS_SERVICE_TOKEN || '').trim();
const CALLBACK_SECRET = (process.env.DARAJA_CALLBACK_SECRET || '').trim();
const TENANT_ID = (process.env.TENANT_ID || '').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '').trim();
const TIMEOUT_PAYER = process.env.TIMEOUT_PAYER || '254700000003';
const SUCCESS_PAYER = process.env.SUCCESS_PAYER || '254700000000';
const HOLD_MS = Number(process.env.HOLD_MS || 90000);
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');

function mark() {
  return new Date().toISOString();
}

function makeDrill(name) {
  const steps = [];
  let failures = 0;
  return {
    name,
    startedAt: mark(),
    steps,
    check(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) failures += 1;
      steps.push({ at: mark(), check: label, ok, actual, expected });
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
      return ok;
    },
    note(label, detail) {
      steps.push({ at: mark(), note: label, ...detail });
      console.log(`  ..... ${label}`);
    },
    get failures() {
      return failures;
    },
  };
}

function traceparent() {
  const id = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(12).toString('hex');
  return { id, header: `00-${id}-${randomBytes(8).toString('hex')}-01` };
}

function attendantHeaders(tp, extra = {}) {
  return {
    traceparent: tp,
    'content-type': 'application/json',
    'x-tenant-id': TENANT_ID,
    'x-user-id': ATTENDANT_ID,
    'x-role': 'attendant',
    ...extra,
  };
}

async function createSale(tp, label) {
  const res = await fetch(`${API}/sales`, {
    method: 'POST',
    headers: attendantHeaders(tp, { 'idempotency-key': `g4-${label}-${randomUUID().slice(0, 8)}` }),
    body: JSON.stringify({ lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }] }),
  });
  return { status: res.status, sale: await res.json() };
}

async function pay(tp, saleId, msisdn, key) {
  const res = await fetch(`${API}/sales/${saleId}/pay`, {
    method: 'POST',
    headers: attendantHeaders(tp, { 'idempotency-key': key }),
    body: JSON.stringify({ msisdn }),
  });
  return { status: res.status, payment: await res.json() };
}

async function readPayment(tp, paymentId) {
  const res = await fetch(`${INTERNAL_BASE}/internal/v1/payments/${paymentId}`, {
    headers: { traceparent: tp, 'x-pos-token': POS_TOKEN },
  });
  return res.status === 200 ? res.json() : null;
}

async function reconcile(tp, paymentId) {
  const res = await fetch(`${INTERNAL_BASE}/internal/v1/payments/${paymentId}/reconcile`, {
    method: 'POST',
    headers: { traceparent: tp, 'content-type': 'application/json', 'x-pos-token': POS_TOKEN },
    body: '{}',
  });
  return { status: res.status, body: await res.json() };
}

function signedCallback(payment, { resultCode = 0, receipt } = {}) {
  const stk = {
    MerchantRequestID: `mr-${payment.id.slice(0, 8)}`,
    CheckoutRequestID: payment.checkout_request_id,
    ResultCode: resultCode,
    ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
  };
  if (resultCode === 0) {
    stk.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: payment.amount_minor / 100 },
        { Name: 'MpesaReceiptNumber', Value: receipt },
        { Name: 'PhoneNumber', Value: Number(SUCCESS_PAYER) },
        { Name: 'TransactionDate', Value: 20260921120000 },
      ],
    };
  }
  const raw = JSON.stringify({ Body: { stkCallback: stk } });
  return { raw, sig: signature.sign(raw, CALLBACK_SECRET, Date.now() / 1000) };
}

async function postCallback(tp, { raw, sig }) {
  const res = await fetch(`${CALLBACK_BASE}/payments/callback`, {
    method: 'POST',
    headers: { traceparent: tp, 'content-type': 'application/json', [signature.SIGNATURE_HEADER]: sig },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

async function drillUncertainPayment() {
  const d = makeDrill('uncertain-payment');
  const tp = traceparent();
  console.log('\n=== DRILL 1: uncertain payment (Daraja timeout) ===');
  console.log(`  trace ${tp.id}`);

  const { status: saleStatus, sale } = await createSale(tp.header, 'timeout');
  d.check('sale created', saleStatus, 201);

  d.note('injecting the fault: charge the timeout payer', { payer: TIMEOUT_PAYER });
  const faultAt = mark();
  const { status: payStatus, payment } = await pay(tp.header, sale.id, TIMEOUT_PAYER, `g4-to-${randomUUID().slice(0, 8)}`);
  d.check('charge accepted despite the timeout', payStatus, 201);
  d.check('payment is pending, not failed', payment.status, 'pending');
  d.check('no failure_reason recorded', payment.failure_reason, null);
  d.check('correlation id survived the timeout', Boolean(payment.checkout_request_id), true);

  console.log(`  holding ${HOLD_MS / 1000}s so the alarm can observe it`);
  await new Promise((r) => setTimeout(r, HOLD_MS));

  const held = await readPayment(tp.header, payment.id);
  d.check('still pending after the hold', held.status, 'pending');
  d.check('never became failed', held.status === 'failed', false);
  d.check('never became timed_out without reconciliation', held.status === 'timed_out', false);

  d.note('first safe action: reconcile (queries Daraja, never re-sends)', {});
  const recoveredAt = mark();
  const rec = await reconcile(tp.header, payment.id);
  d.check('reconcile answered', rec.status, 200);
  d.note('reconcile reason', { reason: rec.body.reconcile_reason, status: rec.body.status });

  const retry = await pay(tp.header, sale.id, TIMEOUT_PAYER, `g4-to-retry-${randomUUID().slice(0, 8)}`);
  d.check('a retry cannot open a second charge', retry.status, 409);
  d.check('the retry names the existing payment', retry.payment.error, 'PAYMENT_ALREADY_EXISTS');

  return {
    drill: d.name,
    fault_injected_at: faultAt,
    recovery_started_at: recoveredAt,
    completed_at: mark(),
    trace_id: tp.id,
    xray_trace_id: `1-${tp.id.slice(0, 8)}-${tp.id.slice(8)}`,
    payer_msisdn: TIMEOUT_PAYER,
    sale_id: sale.id,
    payment_id: payment.id,
    final_status: (await readPayment(tp.header, payment.id))?.status,
    internal_base_url: INTERNAL_BASE,
    detection: {
      alarm: 'devops-g10-payments-oldest-pending',
      metric: 'payments_oldest_pending_age_seconds',
      note: 'capture alarm history and the Slack message for this window from the laptop',
    },
    steps: d.steps,
    passed: d.failures === 0,
  };
}

async function drillCallbackReplay() {
  const d = makeDrill('callback-replay');
  const tp = traceparent();
  console.log('\n=== DRILL 2: callback replay and reorder ===');
  console.log(`  trace ${tp.id}`);

  const { sale } = await createSale(tp.header, 'replay');
  const { payment } = await pay(tp.header, sale.id, SUCCESS_PAYER, `g4-rp-${randomUUID().slice(0, 8)}`);
  d.check('payment pending before any callback', payment.status, 'pending');

  const receipt = `G4${Date.now().toString(36).toUpperCase()}`;
  const success = signedCallback(payment, { receipt });

  const startedAt = mark();
  const first = await postCallback(tp.header, success);
  d.check('first callback applied', first.status, 200);
  d.check('payment paid', first.body.status, 'paid');

  const paidAfterFirst = (await readPayment(tp.header, payment.id)).paid_at;

  const replay = await postCallback(tp.header, success);
  d.check('byte-identical replay is a no-op', replay.body.replay, true);
  d.check('replay does not error', replay.status, 200);

  const late = await postCallback(tp.header, signedCallback(payment, { resultCode: 1032 }));
  d.check('out-of-order decline is rejected', late.status, 409);
  d.check('rejected as an illegal transition', late.body.error, 'illegal_transition');
  d.check('and says what it refused', late.body.from, 'paid');

  const after = await readPayment(tp.header, payment.id);
  d.check('still paid after replay and reorder', after.status, 'paid');
  d.check('paid_at did not move', after.paid_at, paidAfterFirst);
  d.check('one receipt only', after.mpesa_receipt, receipt);

  return {
    drill: d.name,
    started_at: startedAt,
    completed_at: mark(),
    trace_id: tp.id,
    xray_trace_id: `1-${tp.id.slice(0, 8)}-${tp.id.slice(8)}`,
    sale_id: sale.id,
    payment_id: payment.id,
    mpesa_receipt: receipt,
    ledger_effect: 'one transition to paid; replay absorbed; late decline refused',
    steps: d.steps,
    passed: d.failures === 0,
  };
}

async function main() {
  const missing = ['API_URL', 'TENANT_ID', 'ATTENDANT_ID', 'POS_SERVICE_TOKEN', 'DARAJA_CALLBACK_SECRET']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')}`);
    process.exit(2);
  }

  console.log(`\nG4 payment drills — live, timed`);
  console.log(`  API ${API}`);

  const uncertain = await drillUncertainPayment();
  const replay = await drillCallbackReplay();

  for (const [file, data] of [
    ['g4-uncertain-payment.json', uncertain],
    ['g4-callback-replay.json', replay],
  ]) {
    console.log(`EVIDENCE_JSON ${file} ${JSON.stringify(data)}`);
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(data, null, 2) + '\n');
      console.log(`  written ${path.join(OUT_DIR, file)}`);
    } catch (err) {
      console.log(`  could not write ${file}: ${err.code || err.message}`);
    }
  }

  const failed = !uncertain.passed || !replay.passed;
  console.log(`\n${failed ? 'DRILL CHECKS FAILED' : 'ALL DRILL CHECKS PASSED'}`);
  console.log(`X-Ray: ${uncertain.xray_trace_id} (uncertain), ${replay.xray_trace_id} (replay)\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('g4 drills failed:', err);
  process.exit(2);
});
