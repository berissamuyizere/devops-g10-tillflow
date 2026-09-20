# k6 payment helper

For Saloi's load tests. Lets a k6 script complete a payment end to end against
the **fake** adapter, so `payments_*` metrics and the SLIs move under load
rather than stopping at sale creation.

| File | What it is |
|---|---|
| `callback-core.mjs` | Pure logic: the signed-payload string, the header format, the Daraja envelope. No imports, so it is unit-tested from Node. |
| `callback.mjs` | The k6 binding. Imports `k6/crypto` and exports `signCallback` / `signedStkCallback`. |
| `example-payment-flow.mjs` | A worked sale → charge → callback iteration to copy from. |

k6 runs its own runtime, not Node, so the helper cannot use Node's `crypto`.
That is why the signing logic is split: `callback.mjs` uses `k6/crypto.hmac`,
and `callback-core.mjs` stays dependency-free so a Node test can prove the two
signers agree.

## Use

```js
import { signedStkCallback } from './callback.mjs';

const signed = signedStkCallback(
  {
    checkoutRequestId: charge.json('checkout_request_id'),
    amountMinor: charge.json('amount_minor'),
  },
  __ENV.DARAJA_CALLBACK_SECRET
);

http.post(`${API}/payments/callback`, signed.raw, { headers: signed.headers });
```

```bash
API_URL=https://<api-gw> \
POS_SERVICE_TOKEN=... DARAJA_CALLBACK_SECRET=... \
TENANT_ID=... ATTENDANT_ID=... \
  k6 run services/payments/scripts/k6/example-payment-flow.mjs
```

## Things that will bite

**`/internal/*` is blocked from the public edge.** API Gateway stamps
`x-tillflow-edge: public` and the ALB returns 404 for stamped `/internal/*`, so
`POST /internal/v1/charges` fails from a laptop. Either run the payment part
inside the VPC, or use a POS endpoint that starts the charge server-side.
Sale creation over `/sales` is unaffected.

**A payout is unique per (agent, period).** Load that produces many paid sales
for one attendant still yields one payout per day — expected, not a bug.

**The signature window is 300 seconds.** A k6 VU that builds a callback and
posts it much later gets a 401; sign at post time.

**Use payer `254700000000`.** The fake decides the outcome from the last digit:
`…001` insufficient funds, `…002` cancelled, `…003` push timeout, `…004` never
calls back. Only `…000` (or any other ending) succeeds.
