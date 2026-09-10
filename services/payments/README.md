# services/payments

TillFlow Payments API. **Owner: Arsema (Payments + integrity).**

The only service that talks to Daraja. Owns STK push, the payment state
machine, callback handling, reconciliation, and B2C payouts on behalf of
Commission.

Design: [ADR-002 — idempotency and replay safety](../../docs/adrs/ADR-002-idempotency-and-replay-safety.md).
Contracts: [POS ↔ Payments](../../docs/contracts/pos-payments-api.md) (we are the
consumer), [Commission ↔ Payments B2C](../../docs/contracts/commission-payments-b2c.md) (we are the owner).

## The two rules

**A timeout is not a failure.** If Daraja does not answer, we do not know
whether the customer was debited. The payment goes to `pending` and stays
visible until a callback or a `stkQuery` settles it. `timed_out` is reachable
only from reconciliation — never from our own request timing out.

**A callback may re-affirm, never re-transition.** Callbacks arrive duplicated
and out of order. One that asserts a state at or behind where we already are is
a no-op; one inconsistent with a terminal state is rejected and logged. Nothing
a callback says can produce a second charge.

## State machine

```
initiated ──► pending ──► confirmed ──► paid
    │            │
    │            ├──► failed      explicit decline (1, 1032)
    │            └──► timed_out   reconciliation proved expiry (1037)
    └──► failed  Daraja refused the command outright
```

`paid`, `failed` and `timed_out` are terminal and absorb nothing.
See [`src/payments/state.js`](src/payments/state.js).

## Endpoints

| Method | Path | Caller | Auth |
|---|---|---|---|
| `POST` | `/internal/v1/charges` | POS | `X-Pos-Token` |
| `GET` | `/internal/v1/payments/:id` | POS | `X-Pos-Token` |
| `GET` | `/internal/v1/sales/:saleId/payment` | POS | `X-Pos-Token` |
| `POST` | `/internal/v1/payments/:id/reconcile` | POS / scheduler | `X-Pos-Token` |
| `POST` | `/payments/callback` | Daraja | HMAC signature |
| `POST` | `/internal/v1/payouts` | Commission | `X-Commission-Token` |
| `GET` | `/internal/v1/payouts/:id` | Commission | `X-Commission-Token` |
| `GET` | `/health` `/ready` `/version` | ALB / ops | none |

Three separate credentials, deliberately: a leaked POS token must not be able
to move money out via B2C.

`POST /internal/v1/charges` requires an `Idempotency-Key` header (≤64 chars).
Same key + same charge → `200` with the original payment and **no second STK
push**. Same key + different charge → `409`. A *different* key on a sale that
already has a live payment → `409`, enforced by the DB, not by application code.

The amount is always read from the POS sale. Nothing in a request body or a
callback payload can change what we charge.

## Schema

| Table | Purpose |
|---|---|
| `payments.payments` | one row per charge attempt |
| `payments.callback_log` | append-only record of every callback, including rejected ones |
| `payments.payout_ledger` | one row per agent per period |
| `payments.payout_ledger_sales` | which paid sales backed each payout |

The replay guarantees are constraints, not conventions:

| Constraint | Prevents |
|---|---|
| `payments_tenant_idempotency_unique` | two payments for one idempotency key |
| `payments_one_live_per_sale` | a second live charge on the same sale |
| `payments_mpesa_receipt_unique` | one receipt settling two payments |
| `callback_log_hash_unique` (partial, applied rows) | applying the same callback twice |
| `payout_ledger_agent_period_unique` | a second payout for one agent-period |
| `payout_ledger_sales_sale_unique` | one sale backing two payouts |

If every line of application logic were deleted, the database would still
refuse to charge twice or pay twice.

## M-Pesa adapter

`MPESA_MODE` selects the implementation — see
[`services/_shared/mpesa`](../_shared/mpesa/README.md).

- `fake` (default) — deterministic, in-process, no network. **CI and k6 use
  only this.**
- `daraja` — real sandbox. Not implemented yet (G3); `createMpesaClient()`
  throws rather than silently reaching Safaricom.

Pick a test path by picking a payer number: `254700000000` succeeds,
`…001` is insufficient funds, `…002` is cancelled, `…003` makes `stkPush` time
out, `…004` is accepted and then silent.

## Local development

```bash
docker compose up -d --wait                 # Postgres on 5434
export DATABASE_URL=postgres://payments:payments@127.0.0.1:5434/tillflow_payments
npm ci
npm run migrate
npm test
npm run lint
npm start
```

POS uses 5433 and Payments uses 5434, so both can run side by side.

## Tests

| File | Covers |
|---|---|
| `test/invariants-charge.test.js` | replay ⇒ one charge; timeout stays pending; reconciliation |
| `test/invariants-callback.test.js` | duplicate, out-of-order, forged, wrong-amount, unsigned callbacks |
| `test/invariants-payout.test.js` | replayed daily close ⇒ one ledger entry, one B2C |
| `test/state-machine.test.js` | transition table and result-code mapping (no DB) |
| `test/callback-auth.test.js` | HMAC signing, verification, canonicalisation (no DB) |
| `test/mpesa-fake.test.js` | the fake adapter's determinism (no DB) |

The first three need Postgres; the last three do not.

These are the **invariant tests** half of the G2 proof obligation in ADR-002.
The other half is a trace across sale → payment → callback/reconciliation.

## Docker

Payments builds from the **repo root**, not from this directory, because it
needs `services/_shared/mpesa` in its context:

```bash
docker build -f services/payments/Dockerfile -t payments .
```

`services/payments/.dockerignore` is therefore inert — the root
`/.dockerignore` is what applies. Everything else follows the golden path:
multi-stage, pinned `node:20.17-alpine3.20`, non-root uid 10001, `HEALTHCHECK`
on `/health`, no `latest` tag.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | required |
| `MPESA_MODE` | `fake` | `daraja` in production only |
| `DARAJA_CALLBACK_SECRET` | `dev-callback-secret` | HMAC key; Secrets Manager in production |
| `DARAJA_CALLBACK_URL` | `https://localhost/payments/callback` | absolute HTTPS URL given to Daraja |
| `POS_BASE_URL` | `http://pos:8080` | |
| `PAYMENTS_SERVICE_TOKEN` | `dev-payments-token` | what *we* present to POS |
| `POS_SERVICE_TOKEN` | `dev-pos-token` | what POS presents to us |
| `COMMISSION_SERVICE_TOKEN` | `dev-commission-token` | what Commission presents to us |
| `MPESA_B2C_SHORTCODE` | `600000` | |

Real Daraja credentials live in Secrets Manager under `devops-g10/daraja` and
are never committed, never in env files, never in Terraform plaintext.

## Populating the Daraja sandbox secret

Terraform (`infra/secrets.tf`) creates the secret entry with `PLACEHOLDER`
values and `ignore_changes = [secret_string]`, so the real values are set
out-of-band and Terraform will never overwrite or print them. Run this **once**
after the G1 apply lands, with credentials from the Safaricom developer portal:

```bash
aws secretsmanager put-secret-value \
  --secret-id devops-g10/daraja --region eu-central-1 \
  --secret-string '{"consumer_key":"...","consumer_secret":"...","shortcode":"...","passkey":"...","environment":"sandbox"}'
```

Verify without printing the values:

```bash
aws secretsmanager get-secret-value \
  --secret-id devops-g10/daraja --region eu-central-1 \
  --query 'SecretString' --output text | jq 'map_values(type)'
```

- **Sandbox only.** `environment` must be `sandbox`. This system never touches
  real customer funds (threat model, abuse case 9).
- **Never** paste the values into a shell that logs history, a PR, an issue, or
  `evidence/`. The command above takes them inline for brevity; prefer
  `--secret-string file://creds.json` with a file you delete afterwards.
- ECS injects these into the task as environment variables via the task
  definition's `secrets` block — they are read at runtime, never baked into an
  image.
- Rotating the values needs no redeploy of this service beyond a task restart.
