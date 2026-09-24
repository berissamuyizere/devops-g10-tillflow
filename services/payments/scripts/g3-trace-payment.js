#!/usr/bin/env node
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const signature = require('../../_shared/mpesa/signature');

const API = (process.env.API_URL || '').replace(/\/+$/, '');
const CALLBACK_BASE = (process.env.CALLBACK_BASE_URL || API).replace(/\/+$/, '');
const TENANT_ID = (process.env.TENANT_ID || '').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '').trim();
const CALLBACK_SECRET = (process.env.DARAJA_CALLBACK_SECRET || '').trim();
const PAYER = (process.env.PAYER_MSISDN || '254700000000').trim();
const REGION = process.env.AWS_REGION || 'eu-central-1';
const TRACE_WAIT_MS = Number(process.env.TRACE_WAIT_MS || 45000);
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');

const steps = [];
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  steps.push({ check: name, ok, actual, expected });
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`
  );
  return ok;
}

function xrayTraceId() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(12).toString('hex');
}

function requireEnv() {
  const missing = [];
  if (!API) missing.push('API_URL');
  if (!TENANT_ID) missing.push('TENANT_ID');
  if (!ATTENDANT_ID) missing.push('ATTENDANT_ID');
  if (!CALLBACK_SECRET) missing.push('DARAJA_CALLBACK_SECRET');
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')}`);
    process.exit(2);
  }
}

function buildStkCallback({ checkoutRequestId, amountMinor, msisdn, receipt }) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `mr-${receipt}`,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amountMinor / 100 },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'PhoneNumber', Value: Number(msisdn) },
            { Name: 'TransactionDate', Value: 20260921120000 },
          ],
        },
      },
    },
  };
}

async function fetchTrace(traceId) {
  const { XRayClient, BatchGetTracesCommand } = require('@aws-sdk/client-xray');
  const client = new XRayClient({ region: REGION });
  const xrayId = `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
  const out = await client.send(new BatchGetTracesCommand({ TraceIds: [xrayId] }));
  const trace = (out.Traces || [])[0];
  if (!trace) return { xrayId, found: false, segments: [] };
  const segments = (trace.Segments || []).map((s) => {
    let doc = {};
    try {
      doc = JSON.parse(s.Document);
    } catch {
      doc = { unparsed: true };
    }
    return doc;
  });
  return { xrayId, found: true, segments };
}

function summariseTrace(segments) {
  const services = new Set();
  const annotations = {};
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.name) services.add(node.name);
    for (const bag of [node.annotations, node.metadata?.default]) {
      if (bag && typeof bag === 'object') Object.assign(annotations, bag);
    }
    for (const sub of node.subsegments || []) walk(sub);
  };
  segments.forEach(walk);
  return { services: [...services].sort(), annotations };
}

async function main() {
  requireEnv();

  const traceId = xrayTraceId();
  const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
  const attendant = {
    'x-tenant-id': TENANT_ID,
    'x-user-id': ATTENDANT_ID,
    'x-role': 'attendant',
  };
  const hdr = (extra = {}) => ({ traceparent, 'content-type': 'application/json', ...attendant, ...extra });

  console.log(`\nG3 payment trace (public edge, fake M-Pesa)`);
  console.log(`  API      ${API}`);
  console.log(`  payer    ${PAYER}`);
  console.log(`  trace_id ${traceId}\n`);

  console.log('1. create a sale');
  const saleRes = await fetch(`${API}/sales`, {
    method: 'POST',
    headers: hdr({ 'idempotency-key': `g3-sale-${randomUUID().slice(0, 8)}` }),
    body: JSON.stringify({ lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }] }),
  });
  const sale = await saleRes.json();
  check('sale created', saleRes.status, 201);
  check('sale total', sale.total_minor, 15000);

  console.log('2. pay the sale through POS (no /internal from here)');
  const payKey = `g3-pay-${randomUUID().slice(0, 8)}`;
  const payRes = await fetch(`${API}/sales/${sale.id}/pay`, {
    method: 'POST',
    headers: hdr({ 'idempotency-key': payKey }),
    body: JSON.stringify({ msisdn: PAYER }),
  });
  const payment = await payRes.json();
  check('charge accepted', payRes.status, 201);
  check('payment pending', payment.status, 'pending');
  check('charged the POS amount', payment.amount_minor, 15000);

  console.log('3. replay the pay key');
  const replayRes = await fetch(`${API}/sales/${sale.id}/pay`, {
    method: 'POST',
    headers: hdr({ 'idempotency-key': payKey }),
    body: JSON.stringify({ msisdn: PAYER }),
  });
  const replay = await replayRes.json();
  check('replay is 200', replayRes.status, 200);
  check('replay is the same payment', replay.id, payment.id);

  console.log('4. signed callback');
  const receipt = `G3${Date.now().toString(36).toUpperCase()}`;
  const body = buildStkCallback({
    checkoutRequestId: payment.checkout_request_id,
    amountMinor: payment.amount_minor,
    msisdn: PAYER,
    receipt,
  });
  const raw = JSON.stringify(body);
  const signed = signature.sign(raw, CALLBACK_SECRET, Date.now() / 1000);
  const cbRes = await fetch(`${CALLBACK_BASE}/payments/callback`, {
    method: 'POST',
    headers: { traceparent, 'content-type': 'application/json', [signature.SIGNATURE_HEADER]: signed },
    body: raw,
  });
  const cb = await cbRes.json();
  check('callback applied', cbRes.status, 200);
  check('payment paid', cb.status, 'paid');

  console.log('5. replay the callback');
  const cb2 = await fetch(`${CALLBACK_BASE}/payments/callback`, {
    method: 'POST',
    headers: { traceparent, 'content-type': 'application/json', [signature.SIGNATURE_HEADER]: signed },
    body: raw,
  });
  check('callback replay is a no-op', (await cb2.json()).replay, true);

  console.log('6. sale reads back paid');
  const finalSale = await (await fetch(`${API}/sales/${sale.id}`, { headers: hdr() })).json();
  check('sale is paid', finalSale.status, 'paid');
  check('paid_at set once', Boolean(finalSale.paid_at), true);

  const skipXray = process.env.SKIP_XRAY === '1';
  let trace = { found: false, segments: [] };
  let summary = { services: [], annotations: {} };

  if (skipXray) {
    console.log('7. SKIP_XRAY=1 — skipping X-Ray wait and export checks');
  } else {
    console.log(`7. waiting ${TRACE_WAIT_MS / 1000}s for X-Ray, then exporting`);
    await new Promise((r) => setTimeout(r, TRACE_WAIT_MS));
    try {
      trace = await fetchTrace(traceId);
    } catch (err) {
      console.log(`  could not read X-Ray: ${err.message}`);
    }
    check('trace found in X-Ray', trace.found, true);
    summary = summariseTrace(trace.segments);
    check(
      'trace covers pos and payments',
      ['payments', 'pos'].every((s) => summary.services.includes(s)),
      true
    );
  }

  const evidence = {
    captured_at: new Date().toISOString(),
    purpose: 'sale -> pay -> callback on the live stack through the public edge, one trace',
    api_url: API,
    callback_base_url: CALLBACK_BASE,
    mpesa_mode: 'fake',
    payer_msisdn: PAYER,
    trace_id: traceId,
    xray_trace_id: trace.xrayId || `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`,
    traceparent,
    sale_id: sale.id,
    payment_id: payment.id,
    mpesa_receipt: receipt,
    trace_services: summary.services,
    trace_annotations: summary.annotations,
    trace_segment_count: trace.segments.length,
    checks: steps,
    skip_xray: skipXray,
    passed: failures === 0,
  };

  console.log('EVIDENCE_JSON ' + JSON.stringify(evidence));

  const outFile = path.join(OUT_DIR, 'g3-trace-payment.json');
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`evidence written to ${outFile}`);
  } catch (err) {
    console.log(`could not write ${outFile}: ${err.code || err.message}`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`X-Ray: ${evidence.xray_trace_id}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('g3 trace capture failed:', err);
  process.exit(2);
});
