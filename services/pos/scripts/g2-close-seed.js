#!/usr/bin/env node
/**
 * G2 close — Berissa (Product + POS).
 *
 * Seeds paid sales for today's Africa/Nairobi business day, creates one
 * unpaid sale as a control, proves GET /internal/v1/commission/eligible,
 * and writes evidence under evidence/product-pos/.
 *
 * Requires the live stack (Release green, POS + Payments on ECS).
 * MPESA_MODE=fake — same happy-path as payments/scripts/g2-happy-path.js.
 *
 * Usage (after fetching service tokens from Secrets Manager):
 *
 *   export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
 *   export PAYMENTS_SERVICE_TOKEN=…   # POS /internal auth
 *   export POS_SERVICE_TOKEN=…        # Payments charge auth
 *   export DARAJA_CALLBACK_SECRET=…
 *   export TENANT_ID=11111111-1111-1111-1111-111111111111
 *   export ATTENDANT_ID=22222222-2222-2222-2222-222222222222
 *   node services/pos/scripts/g2-close-seed.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../_shared/mpesa');

const API = (process.env.API_URL || process.env.POS_BASE_URL || '').replace(/\/+$/, '');
const PAYMENTS = (process.env.PAYMENTS_BASE_URL || API).replace(/\/+$/, '');
const POS = (process.env.POS_BASE_URL || API).replace(/\/+$/, '');

const PAYMENTS_TOKEN = (process.env.PAYMENTS_SERVICE_TOKEN || '').trim();
const POS_TOKEN = (process.env.POS_SERVICE_TOKEN || '').trim();
const CALLBACK_SECRET = (process.env.DARAJA_CALLBACK_SECRET || '').trim();

const TENANT_ID = (process.env.TENANT_ID || '').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '').trim();

const OUT_DIR =
  process.env.EVIDENCE_DIR ||
  path.resolve(__dirname, '../../../evidence/product-pos');

const checks = [];
let failures = 0;

function eatBusinessDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  checks.push({ check: name, ok, actual, expected });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(
    `  [${mark}] ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`
  );
  return ok;
}

function assertPresent(name, value) {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  checks.push({ check: name, ok, actual: value || null });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  return ok;
}

async function main() {
  if (!POS || !PAYMENTS) {
    console.error('API_URL or POS_BASE_URL is required.');
    process.exit(2);
  }
  if (!PAYMENTS_TOKEN || !POS_TOKEN || !CALLBACK_SECRET) {
    console.error('PAYMENTS_SERVICE_TOKEN, POS_SERVICE_TOKEN, and DARAJA_CALLBACK_SECRET are required.');
    process.exit(2);
  }
  if (!TENANT_ID || !ATTENDANT_ID) {
    console.error('TENANT_ID and ATTENDANT_ID are required (see evidence/product-pos/g2-seed.json).');
    process.exit(2);
  }

  const businessDay = process.env.BUSINESS_DAY || eatBusinessDay();
  const paidKey = process.env.PAID_IDEMPOTENCY_KEY || `g2-close-paid-${randomUUID().slice(0, 8)}`;
  const unpaidKey = process.env.UNPAID_IDEMPOTENCY_KEY || `g2-close-unpaid-${randomUUID().slice(0, 8)}`;
  const chargeKey = process.env.CHARGE_IDEMPOTENCY_KEY || `g2-close-charge-${randomUUID().slice(0, 8)}`;

  const attendant = {
    'x-tenant-id': TENANT_ID,
    'x-user-id': ATTENDANT_ID,
    'x-role': 'attendant',
    'content-type': 'application/json',
  };

  console.log(`\nG2 close seed (Berissa)\n  API          ${API || POS}\n  business_day ${businessDay} (EAT)\n`);

  // --- unpaid control sale (must NOT appear in eligible) ------------------
  console.log('1. create unpaid sale (control)');
  const unpaidRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: { ...attendant, 'idempotency-key': unpaidKey },
    body: JSON.stringify({
      lines: [{ description: 'Unpaid control', quantity: 1, unit_price_minor: 5000 }],
    }),
  });
  const unpaid = await unpaidRes.json();
  check('unpaid sale created', unpaidRes.status, 201);
  check('unpaid sale status', unpaid.status, 'created');

  // --- paid sale for today's EAT business day ---------------------------
  console.log('2. create paid sale');
  const saleRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: { ...attendant, 'idempotency-key': paidKey },
    body: JSON.stringify({
      lines: [{ description: 'Close seed chai', quantity: 2, unit_price_minor: 7500 }],
    }),
  });
  const sale = await saleRes.json();
  check('paid sale created', saleRes.status, 201);
  check('paid sale total_minor', sale.total_minor, 15000);

  console.log('3. charge (fake STK success)');
  const chargeRes = await fetch(`${PAYMENTS}/internal/v1/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pos-token': POS_TOKEN,
      'idempotency-key': chargeKey,
    },
    body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS }),
  });
  const payment = await chargeRes.json();
  check('charge accepted', chargeRes.status, 201);
  check('payment pending', payment.status, 'pending');

  console.log('4. callback → paid');
  const mpesa = createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET });
  await mpesa.stkPush({
    shortcode: sale.mpesa_till || '174379',
    amountMinor: payment.amount_minor,
    msisdn: TEST_MSISDNS.SUCCESS,
    accountReference: sale.id,
    transactionDesc: 'TillFlow close seed',
    callbackUrl: `${PAYMENTS}/payments/callback`,
  });
  const cbBody = mpesa.buildCallback(payment.checkout_request_id);
  if (!cbBody) {
    console.error('fake callback build failed');
    process.exit(2);
  }
  const signed = mpesa.signBody(cbBody, Date.now());
  const cbRes = await fetch(`${PAYMENTS}/payments/callback`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.raw,
  });
  const cbJson = await cbRes.json();
  check('callback applied', cbRes.status, 200);
  check('payment paid', cbJson.status, 'paid');

  const paidSale = await (await fetch(`${POS}/sales/${sale.id}`, { headers: attendant })).json();
  check('sale is paid', paidSale.status, 'paid');
  assertPresent('sale has paid_at', paidSale.paid_at);
  check('paid_at is on business day', eatBusinessDay(new Date(paidSale.paid_at)), businessDay);

  // --- commission eligible proof ----------------------------------------
  console.log('5. GET /internal/v1/commission/eligible');
  const eligibleUrl = new URL(`${POS}/internal/v1/commission/eligible`);
  eligibleUrl.searchParams.set('tenant_id', TENANT_ID);
  eligibleUrl.searchParams.set('business_day', businessDay);

  const eligibleRes = await fetch(eligibleUrl, {
    headers: { 'x-payments-token': PAYMENTS_TOKEN },
  });
  const eligible = await eligibleRes.json();
  check('eligible 200', eligibleRes.status, 200);

  const paidRow = (eligible.sales || []).find((s) => s.id === sale.id);
  const unpaidRow = (eligible.sales || []).find((s) => s.id === unpaid.id);

  assertPresent('paid sale in eligible list', paidRow);
  if (paidRow) {
    check('eligible payout_msisdn', paidRow.payout_msisdn, '254700000000');
    check('eligible commission_bps', paidRow.commission_bps, 500);
    check('eligible status', paidRow.status, 'paid');
    check('eligible total_minor', paidRow.total_minor, 15000);
  }
  check('unpaid sale excluded', unpaidRow, undefined);

  const evidence = {
    captured_at: new Date().toISOString(),
    gate: 'G2',
    owner: 'Berissa (Product + POS)',
    business_day_eat: businessDay,
    api_url: API || POS,
    mpesa_mode: 'fake',
    seed: {
      tenant_id: TENANT_ID,
      attendant_id: ATTENDANT_ID,
      payout_msisdn: '254700000000',
      commission_bps: 500,
    },
    sales: {
      paid: {
        id: sale.id,
        idempotency_key: paidKey,
        status: paidSale.status,
        total_minor: paidSale.total_minor,
        paid_at: paidSale.paid_at,
        payment_id: paidSale.payment_id ?? payment.id,
      },
      unpaid_control: {
        id: unpaid.id,
        idempotency_key: unpaidKey,
        status: unpaid.status,
      },
    },
    payment_id: payment.id,
    charge_idempotency_key: chargeKey,
    eligible_request: {
      url: eligibleUrl.toString(),
      tenant_id: TENANT_ID,
      business_day: businessDay,
    },
    eligible_response: eligible,
    checks,
    passed: failures === 0,
    reproduce: [
      'export API_URL=<api-gateway-url>',
      'export PAYMENTS_SERVICE_TOKEN POS_SERVICE_TOKEN DARAJA_CALLBACK_SECRET from devops-g10/service-tokens + daraja',
      'export TENANT_ID ATTENDANT_ID from evidence/product-pos/g2-seed.json',
      'node services/pos/scripts/g2-close-seed.js',
    ],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `g2-close-eligible-${businessDay}.json`);
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`evidence written to ${outFile}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('g2 close seed failed:', err);
  process.exit(2);
});
