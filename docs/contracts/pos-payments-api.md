# POS ↔ Payments contract

**Owner (POS side):** Berissa  
**Consumer:** Arsema (Payments)  
**Status:** Proposed for agreement before Payments callback handling  

Freeze this shape before G2 callback work. Changes need a PR reviewed by both CODEOWNERS on the money path.

## Auth

Payments calls POS with:

```
X-Payments-Token: <shared secret>
```

Value comes from env `PAYMENTS_SERVICE_TOKEN` (later: Secrets Manager). Local default for tests: `dev-payments-token`.

POS never accepts sale status changes from attendants for `awaiting_payment` or `paid`.

## Sale read (before STK)

```
GET /internal/v1/sales/:sale_id
X-Payments-Token: ...
```

**200**

```json
{
  "id": "uuid",
  "tenant_id": "uuid",
  "attendant_id": "uuid",
  "status": "created",
  "currency": "KES",
  "total_minor": 15000,
  "created_at": "2026-09-10T12:00:00.000Z",
  "paid_at": null,
  "mpesa_till": "174379",
  "lines": [
    {
      "id": "uuid",
      "description": "Chai",
      "quantity": 2,
      "unit_price_minor": 7500,
      "line_total_minor": 15000
    }
  ],
  "attendant": {
    "id": "uuid",
    "display_name": "Ada",
    "payout_msisdn": "254712345678",
    "commission_bps": 500,
    "status": "active"
  }
}
```

**404** — unknown `sale_id` (no cross-tenant leak of existence beyond id).

Payments must charge `total_minor` and till from this response — not a second client-supplied amount at callback time.

## Command accepted → awaiting_payment

Call when Daraja STK (or fake adapter) command is accepted by Payments:

```
POST /internal/v1/sales/:sale_id/awaiting-payment
X-Payments-Token: ...
Content-Type: application/json

{ "payment_id": "uuid" }
```

`payment_id` is optional metadata for tracing; POS does not persist it in G2 scaffold (Payments owns payment rows).

| Current status | Result |
|---|---|
| `created` | → `awaiting_payment`, **200** |
| anything else | **409** `ILLEGAL_TRANSITION` |

## Paid → paid

Call only after callback or reconcile confirms money:

```
POST /internal/v1/sales/:sale_id/paid
X-Payments-Token: ...
Content-Type: application/json

{ "payment_id": "uuid", "paid_at": "2026-09-10T12:01:00.000Z" }
```

| Current status | Result |
|---|---|
| `awaiting_payment` | → `paid`, set `paid_at` once, **200** |
| `paid` | **200** no-op (same `paid_at`, totals unchanged) |
| `created` / `cancelled` | **409** `ILLEGAL_TRANSITION` |

**Timeout is not a decline.** Do not call cancel or paid on timeout; leave sale in `awaiting_payment` until reconcile.

## Commission eligibility (helper for Commission / tests)

```
GET /internal/v1/commission/eligible?tenant_id=<uuid>&business_day=2026-09-10
X-Payments-Token: ...
```

`business_day` is the Africa/Nairobi calendar date. Response includes only sales with `status=paid` and `paid_at` on that day. Unpaid sales are never returned.

## What Payments must not do

- Insert or update sale lines / `total_minor`
- Treat Daraja timeout as cancel
- Call Commission
- Call Daraja from Commission (B2C stays on Payments)

## Attendant create-sale (for context)

```
POST /sales
Idempotency-Key: <≤64 chars>
X-Tenant-Id: ...
X-User-Id: ...   # attendant user id
X-Role: attendant

{ "lines": [ { "description": "...", "quantity": 1, "unit_price_minor": 100 } ] }
```

Same key + same body → **200** original. Same key + different body → **409**. Missing key → **400**.
