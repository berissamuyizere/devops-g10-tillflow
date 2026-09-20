/**
 * G3 load — public API Gateway only. WAF must be raised first (waf_rate_limit).
 *
 *   SCENARIO=smoke|baseline|spike|soak|full k6 run .../g3-load.js \
 *     --summary-export evidence/reliability-operations/k6-g3-<scenario>.json
 *
 * Counted toward WAF: sale + pay + GET (callback path is exempt).
 * Soak stays under 2000 req / 5 min / IP (~2 iter/s × 3 counted ≈ 6 rps).
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { signedStkCallback } from '../../../services/payments/scripts/k6/callback.mjs';

const API = (__ENV.API_URL || '').replace(/\/+$/, '');
const CALLBACK_SECRET = __ENV.DARAJA_CALLBACK_SECRET;
const TENANT_ID = __ENV.TENANT_ID;
const ATTENDANT_ID = __ENV.ATTENDANT_ID;
const SUCCESS_PAYER = '254700000000';
const SCENARIO = __ENV.SCENARIO || 'full';

const scenarios = {
  smoke: {
    smoke: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      maxDuration: '2m',
    },
  },
  baseline: {
    baseline: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 12,
      maxVUs: 20,
      stages: [
        { duration: '1m', target: 1 },
        { duration: '1m', target: 2 },
        { duration: '2m', target: 2 },
      ],
    },
  },
  spike: {
    spike: {
      executor: 'constant-arrival-rate',
      rate: 6,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 30,
    },
  },
  soak: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 16,
      maxVUs: 24,
    },
  },
  full: {
    smoke: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      maxDuration: '2m',
    },
    baseline: {
      executor: 'ramping-arrival-rate',
      startTime: '2m',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 12,
      maxVUs: 20,
      stages: [
        { duration: '1m', target: 1 },
        { duration: '1m', target: 2 },
        { duration: '2m', target: 2 },
      ],
    },
    spike: {
      executor: 'constant-arrival-rate',
      startTime: '6m',
      rate: 6,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 30,
    },
    soak: {
      executor: 'constant-arrival-rate',
      startTime: '7m',
      rate: 2,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 16,
      maxVUs: 24,
    },
  },
};

export const options = {
  scenarios: scenarios[SCENARIO] || scenarios.full,
  thresholds: {
    checks: ['rate>0.95'],
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(95)<2000'],
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

  const key = `k6-load-${__VU}-${__ITER}-${Date.now()}`;

  const sale = http.post(
    `${API}/sales`,
    JSON.stringify({
      lines: [{ description: 'Chai', quantity: 1, unit_price_minor: 7500 }],
    }),
    { headers: attendantHeaders({ 'Idempotency-Key': key }), tags: { name: 'sale' } }
  );
  check(sale, { 'sale created': (r) => r.status === 201 });
  if (sale.status !== 201) return;
  const saleId = sale.json('id');

  const pay = http.post(
    `${API}/sales/${saleId}/pay`,
    JSON.stringify({ msisdn: SUCCESS_PAYER }),
    { headers: attendantHeaders({ 'Idempotency-Key': `pay-${key}` }), tags: { name: 'pay' } }
  );
  check(pay, { 'pay accepted': (r) => r.status === 201 || r.status === 200 });
  if (pay.status !== 201 && pay.status !== 200) return;

  const signed = signedStkCallback(
    {
      checkoutRequestId: pay.json('checkout_request_id'),
      amountMinor: pay.json('amount_minor'),
      msisdn: SUCCESS_PAYER,
      mpesaReceipt: `K6L${__VU}${__ITER}${String(Date.now()).slice(-6)}`,
    },
    CALLBACK_SECRET
  );

  const cb = http.post(`${API}/payments/callback`, signed.raw, {
    headers: signed.headers,
    tags: { name: 'callback' },
  });
  check(cb, { 'callback applied': (r) => r.status === 200 });

  const paid = http.get(`${API}/sales/${saleId}`, {
    headers: attendantHeaders(),
    tags: { name: 'sale_get' },
  });
  check(paid, { 'sale is paid': (r) => r.status === 200 && r.json('status') === 'paid' });
}
