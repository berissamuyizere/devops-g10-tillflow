# POS ↔ Payments contract

**Owner (POS side):** Berissa  
**Consumer:** Arsema (Payments)  
**Status:** Accepted — frozen for G2 (2026-09-14)  

This shape is frozen for G2. Any change needs a PR reviewed by both money-path
CODEOWNERS (`@berissamuyizere` and `@arsemagebremichael`).

## Invariants frozen for G2

1. **Sale totals never change after creation.** Line items and `total_minor`
   are immutable once the sale exists; POS exposes no endpoint to edit them.
   Payments charges the `total_minor` returned by the sale read — never a
   second, client-supplied amount.
2. **The attendant cannot change a sale once it is `awaiting_payment`.** The
   only attendant/owner-driven status change is cancel, and cancel is allowed
   **only from `created`**. After Payments has accepted a charge
   (`awaiting_payment`), POS rejects any attendant status change with **409
   `ILLEGAL_TRANSITION`**. This prevents a cancel racing a success callback.
3. **Only Payments moves a sale to `awaiting_payment` or `paid`,** and only via
   the `/internal/v1/*` endpoints authenticated with the service token.
4. **A timeout is not a decline.** POS never moves `awaiting_payment` to
   `paid` or `cancelled` on its own; the sale stays pending until Payments
   confirms or reconciles.
5. **Paid is terminal and replay-safe.** A repeated `paid` call is a 200 no-op
   with the original `paid_at` and totals unchanged.

## Auth

Payments calls POS with:

```
X-Payments-Token: <shared secret>
```

Value comes from env `PAYMENTS_SERVICE_TOKEN` (Secrets Manager in ECS; `dev-payments-token` only when that env is set in tests/CI/compose). If the env is unset, POS **fail-closes** (`500 misconfigured`) — there is no in-process default.

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

`payment_id` is optional on this call (Payments owns payment rows). POS persists `payment_id` on `POST .../paid`.

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

`payment_id` is **required**. POS stores it on the sale.

| Current status | Result |
|---|---|
| `awaiting_payment` | → `paid`, set `paid_at` and `payment_id` once, **200** |
| `paid` + same `payment_id` | **200** no-op (same `paid_at`, totals, `payment_id`) |
| `paid` + different `payment_id` | **409** `PAYMENT_ID_MISMATCH` |
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
