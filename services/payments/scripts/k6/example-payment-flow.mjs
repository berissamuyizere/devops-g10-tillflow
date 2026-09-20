import http from 'k6/http';
import { check } from 'k6';
import { signedStkCallback } from './callback.mjs';

const API = __ENV.API_URL;
const POS_TOKEN = __ENV.POS_SERVICE_TOKEN;
const CALLBACK_SECRET = __ENV.DARAJA_CALLBACK_SECRET;
const TENANT_ID = __ENV.TENANT_ID;
const ATTENDANT_ID = __ENV.ATTENDANT_ID;
const SUCCESS_PAYER = '254700000000';

export default function payOneSale() {
  const key = `k6-${__VU}-${__ITER}-${Date.now()}`;

  const sale = http.post(
    `${API}/sales`,
    JSON.stringify({ lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-Tenant-Id': TENANT_ID,
        'X-User-Id': ATTENDANT_ID,
        'X-Role': 'attendant',
      },
    }
  );
  check(sale, { 'sale created': (r) => r.status === 201 });
  if (sale.status !== 201) return;
  const saleId = sale.json('id');

  const charge = http.post(
    `${API}/internal/v1/charges`,
    JSON.stringify({ sale_id: saleId, msisdn: SUCCESS_PAYER }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Pos-Token': POS_TOKEN,
        'Idempotency-Key': `chg-${key}`,
      },
    }
  );
  check(charge, { 'charge accepted': (r) => r.status === 201 });
  if (charge.status !== 201) return;

  const signed = signedStkCallback(
    {
      checkoutRequestId: charge.json('checkout_request_id'),
      amountMinor: charge.json('amount_minor'),
      msisdn: SUCCESS_PAYER,
      mpesaReceipt: `K6${__VU}${__ITER}`,
    },
    CALLBACK_SECRET
  );

  const cb = http.post(`${API}/payments/callback`, signed.raw, { headers: signed.headers });
  check(cb, {
    'callback applied': (r) => r.status === 200,
    'sale is paid': (r) => r.json('status') === 'paid',
  });
}
