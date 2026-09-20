/**
 * G3 k6 — public API Gateway only.
 * Sale → POST /sales/:id/pay → signed callback. Never /internal/*.
 *
 *   API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com \
 *   DARAJA_CALLBACK_SECRET=... TENANT_ID=... ATTENDANT_ID=... \
 *     k6 run evidence/reliability-operations/k6/g3-public-pay.js
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { signedStkCallback } from '../../../services/payments/scripts/k6/callback.mjs';

const API = (__ENV.API_URL || '').replace(/\/+$/, '');
const CALLBACK_SECRET = __ENV.DARAJA_CALLBACK_SECRET;
const TENANT_ID = __ENV.TENANT_ID;
const ATTENDANT_ID = __ENV.ATTENDANT_ID;
const SUCCESS_PAYER = '254700000000';

export const options = {
  vus: 1,
  iterations: 3,
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.05'],
  },
};

function attendantHeaders(extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      'X-Tenant-Id': TENANT_ID,
      'X-User-Id': ATTENDANT_ID,
      'X-Role': 'attendant',
    },
    extra || {}
  );
}

export default function publicPayOneSale() {
  if (!API || !CALLBACK_SECRET || !TENANT_ID || !ATTENDANT_ID) {
    fail('API_URL, DARAJA_CALLBACK_SECRET, TENANT_ID, ATTENDANT_ID are required');
  }

  const key = `k6-g3-${__VU}-${__ITER}-${Date.now()}`;

  const sale = http.post(
    `${API}/sales`,
    JSON.stringify({
      lines: [{ description: 'Chai', quantity: 1, unit_price_minor: 7500 }],
    }),
    { headers: attendantHeaders({ 'Idempotency-Key': key }) }
  );
  check(sale, { 'sale created': (r) => r.status === 201 });
  if (sale.status !== 201) return;
  const saleId = sale.json('id');

  const pay = http.post(
    `${API}/sales/${saleId}/pay`,
    JSON.stringify({ msisdn: SUCCESS_PAYER }),
    { headers: attendantHeaders({ 'Idempotency-Key': `pay-${key}` }) }
  );
  check(pay, { 'pay accepted': (r) => r.status === 201 || r.status === 200 });
  if (pay.status !== 201 && pay.status !== 200) return;

  const signed = signedStkCallback(
    {
      checkoutRequestId: pay.json('checkout_request_id'),
      amountMinor: pay.json('amount_minor'),
      msisdn: SUCCESS_PAYER,
      mpesaReceipt: `K6G3${__VU}${__ITER}`,
    },
    CALLBACK_SECRET
  );

  const cb = http.post(`${API}/payments/callback`, signed.raw, { headers: signed.headers });
  check(cb, { 'callback applied': (r) => r.status === 200 });

  const paid = http.get(`${API}/sales/${saleId}`, { headers: attendantHeaders() });
  check(paid, { 'sale is paid': (r) => r.status === 200 && r.json('status') === 'paid' });
}
