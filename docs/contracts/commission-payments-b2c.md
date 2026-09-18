# Commission ↔ Payments B2C contract

**Owner (Payments side):** Arsema
**Consumer:** Commission (Berissa + Arsema on the money path)
**Status:** Accepted — B2C result callback and timeout semantics implemented (2026-09-18)

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

**201 Created** — ledger entry created and the B2C command **accepted by Daraja**:

```json
{
  "id": "uuid",
  "tenant_id": "uuid",
  "agent_id": "uuid",
  "period": "2026-09-10",
  "status": "disbursing",
  "gross_sales_minor": 30000,
  "commission_bps": 500,
  "amount_minor": 1500,
  "msisdn": "254712345678",
  "originator_conversation_id": "tillflow-<agent_id>-2026-09-10",
  "conversation_id": "AG-...",
  "accepted_at": "2026-09-10T21:00:00.000Z",
  "disbursed_at": null,
  "disburse_reason": "accepted_awaiting_result"
}
```

**`status` is `disbursing`, not `disbursed`.** Daraja's `responseCode: "0"` means
the command was *accepted for processing*, not that money moved. Only the B2C
result callback (below) may set `disbursed`. Treating acceptance as completion
is how a failed payout gets recorded as paid.

**200 OK** — replay. The ledger entry already existed; **no second B2C was
sent**. Body is the existing entry plus `"replay": true`.

| Condition | Status | `error` |
|---|---|---|
| Replay of the same close | `200` | — (`replay: true`) |
| B2C timed out (outcome unknown) | `201`, `status: disbursing` | — (`disburse_reason: b2c_timeout_unknown`) |
| Daraja refused the command | `201`, `status: failed` | — (`disburse_reason: b2c_rejected`) |
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

## B2C result callback

Daraja answers B2C asynchronously. Payments exposes:

```
POST /payments/b2c/callback
X-TillFlow-Signature: t=<unix>,v1=<hex hmac-sha256>
```

Same HMAC scheme as the STK callback — no service token, because the caller is
not one of our services. Body is Daraja's B2C `Result` envelope, matched to a
ledger row on `OriginatorConversationID`.

| Result code | Ledger becomes |
|---|---|
| `0` | `disbursed`, `disbursed_at` and `b2c_transaction_id` set |
| any other terminal code | `failed`, `failure_reason` set |
| `1100` (still processing) | unchanged |

Checks applied before anything moves, in order: signature, envelope shape,
`OriginatorConversationID` matches a ledger row we created, amount equals the
ledger amount, and the transition is legal. A replayed callback is a `200`
no-op; a late failure after `disbursed` is a `409` and is logged. Every
delivery — accepted, replayed or rejected — is written to
`payments.payout_callback_log`.

## Reconciliation

```
POST /internal/v1/payouts/:ledger_id/reconcile
X-Commission-Token: ...
```

For payouts stuck in `disbursing` because the command timed out or the result
callback never arrived. Queries Daraja and settles from the answer. It never
re-sends the B2C. A "still processing" answer changes nothing and is not an
error.

## Timeout is not a decline

If `b2c` times out or the connection fails, the outcome is **unknown**: the
command may have been executed. The ledger row stays `disbursing` with
`b2c_sync_error` recorded. It is **never** returned to `pending`, because
`pending` is the state the daily close picks up — a replayed close would then
send a second B2C for money that may already have moved.

Only a synchronous refusal from Daraja, where we know nothing was executed,
moves the row to `failed`.

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
| `payout_callback_log_ledger_unique` | applying two result callbacks to one payout |
| `payout_ledger_b2c_transaction_unique` | one Daraja transaction settling two payouts |

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

- **Who triggers the close.** EventBridge schedule vs. Commission's own cron.
  Owner: Yordanos + Arsema at G2.
- **Partial-period corrections.** Currently impossible by construction (one
  payout per agent per period, forever). If the business needs adjustments, they
  should be a *new* compensating ledger entry type, never an edit to an existing
  row.
