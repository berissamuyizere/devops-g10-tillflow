# Commission ↔ Payments B2C contract

**Owner (Payments side):** Arsema
**Consumer:** Commission (Berissa + Arsema on the money path)
**Status:** Stub — proposed for agreement before Commission's daily close is built

Freeze this shape before the daily-close job exists. Changes need a PR reviewed
by both CODEOWNERS on the money path.

## The rule this contract exists to enforce

**Commission never calls Daraja.** It has no Daraja credentials, no Daraja task
role permission, and no network path to Safaricom. It calculates who is owed
what and asks Payments to disburse. This is ADR-002 and threat-model abuse
case 6; the contract is the mechanism.

Payments is correspondingly suspicious of what Commission sends: the sale ids
below are an *input*, not an authority. Payments recomputes the payable set
from its own `payments` table and pays only for sales it recorded as `paid`.

## Auth

```
X-Commission-Token: <shared secret>
```

From env `COMMISSION_SERVICE_TOKEN` (later: Secrets Manager). Local default for
tests: `dev-commission-token`.

Deliberately a *different* token from `X-Pos-Token`. A leaked POS token must not
be able to move money out via B2C.

## Request a payout

```
POST /internal/v1/payouts
X-Commission-Token: ...
Idempotency-Key: <agent_id>:<period>      # optional; defaults to exactly this
Content-Type: application/json

{
  "tenant_id": "uuid",
  "agent_id": "uuid",
  "period": "2026-09-10",
  "msisdn": "254712345678",
  "commission_bps": 500,
  "sales": ["uuid", "uuid"]
}
```

- `period` — the Africa/Nairobi business day, `YYYY-MM-DD`. One payout per
  agent per period, enforced by `payout_ledger_agent_period_unique`.
- `commission_bps` — basis points, integer 0..10000. Commission is
  `floor(gross * bps / 10000)`; rounding is always **down**, so a payout can
  never exceed what was earned.
- `sales` — the sale ids Commission believes are eligible. Payments filters
  these down to the ones it has as `paid` and ignores the rest.

**201 Created** — ledger entry created and B2C sent:

```json
{
  "id": "uuid",
  "tenant_id": "uuid",
  "agent_id": "uuid",
  "period": "2026-09-10",
  "status": "disbursed",
  "gross_sales_minor": 30000,
  "commission_bps": 500,
  "amount_minor": 1500,
  "msisdn": "254712345678",
  "originator_conversation_id": "tillflow-<agent_id>-2026-09-10",
  "conversation_id": "AG-...",
  "disbursed_at": "2026-09-10T21:00:00.000Z",
  "disburse_reason": "disbursed"
}
```

**200 OK** — replay. The ledger entry already existed; **no second B2C was
sent**. Body is the existing entry plus `"replay": true`.

| Condition | Status | `error` |
|---|---|---|
| Replay of the same close | `200` | — (`replay: true`) |
| Same agent + period, different amount | `409` | `PAYOUT_CONFLICT` |
| None of the supplied sales are `paid` | `409` | `NO_ELIGIBLE_SALES` |
| A supplied sale already backs another payout | `409` | `SALE_ALREADY_PAID_OUT` |
| Computed commission is zero | `409` | `ZERO_COMMISSION` |
| Bad `period` / `msisdn` / `commission_bps` | `400` | `VALIDATION` |
| Missing or wrong token | `401` | `unauthorized` |

## Read a payout

```
GET /internal/v1/payouts/:ledger_id
X-Commission-Token: ...
```

Returns the ledger entry, or `404`.

## Replay semantics

The daily close is expected to be re-run — after a crash, a duplicated cron
firing, or a manual re-trigger from the runbook. Re-running it is safe and is
tested as such (`test/invariants-payout.test.js`).

Three constraints make it safe, and none of them is application logic:

| Constraint | Prevents |
|---|---|
| `payout_ledger_agent_period_unique (agent_id, period)` | a second ledger entry for the same close |
| `payout_ledger_sales_sale_unique (sale_id)` | one sale backing two payouts |
| `payout_ledger_originator_unique` | two B2C commands from one ledger row |

Disbursement claims the row (`pending` → `disbursing`) before calling Daraja,
so a concurrent second call finds it already claimed and sends nothing. If B2C
fails, the row returns to `pending` and a later run retries under the **same**
`originator_conversation_id`.

## What Commission must not do

- Call Daraja directly — B2C, STK, or anything else.
- Hold Daraja credentials or a Daraja-capable task role.
- Pay out on sales that are not `paid` (Payments re-checks regardless).
- Write to `payments.*` tables.
- Treat a `409` as retryable. Every `409` here means "this is already handled
  or genuinely disagrees" — retrying will not change it.

## Open questions before this leaves stub status

- **B2C result callback.** Daraja B2C answers asynchronously on a result URL.
  This stub treats a `responseCode: "0"` acceptance as `disbursed`; a real
  implementation needs a `disbursing` → `disbursed`/`failed` transition driven
  by that callback, authenticated the same way as the STK callback. Owner:
  Arsema, before G3.
- **Who triggers the close.** EventBridge schedule vs. Commission's own cron.
  Owner: Yordanos + Arsema at G2.
- **Partial-period corrections.** Currently impossible by construction (one
  payout per agent per period, forever). If the business needs adjustments, they
  should be a *new* compensating ledger entry type, never an edit to an existing
  row.
