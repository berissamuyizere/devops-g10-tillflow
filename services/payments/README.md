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
| `POST` | `/internal/v1/pos-sync/sweep` | scheduler / runbook | `X-Pos-Token` |
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
| `test/pos-wiring.test.js` | POS sync recording, conflicts, outages, the sweeper |
| `test/contract-pos-live.contract.js` | **the real POS service**, over real HTTP |
| `test/trace-propagation.contract.js` | one trace id across both services, two real processes |

`npm test` runs everything matching `test/*.test.js`. The contract test is
excluded from that glob on purpose and runs separately.

These are the **invariant tests** half of the G2 proof obligation in ADR-002.
The other half is a trace across sale → payment → callback/reconciliation.

## POS wiring

Payments never writes sale rows. The only sale state lives in POS, and Payments
moves it strictly through the frozen contract
([docs/contracts/pos-payments-api.md](../../docs/contracts/pos-payments-api.md)),
authenticated with `X-Payments-Token`:

1. **Read the sale** before anything else. `total_minor` and `mpesa_till` come
   from that response — never from the charge request body or a callback.
2. **`POST .../awaiting-payment`** once the STK command is accepted.
3. **`POST .../paid`** once a callback or a reconcile query confirms money moved.

### When POS disagrees or disappears

The three outcomes of a POS call are genuinely different and are not collapsed:

| POS says | Meaning | What Payments does |
|---|---|---|
| `200` | applied | stamp `pos_awaiting_synced_at` / `pos_paid_synced_at` |
| `409 ILLEGAL_TRANSITION` | a decision — the sale was cancelled first | record `pos_sync_error`, **keep the payment alive** |
| `5xx` / unreachable | unknown | record `pos_sync_error`, retry via the sweeper |

A POS problem must never unwind a charge that has already reached Daraja. So a
409 on `awaiting-payment` does **not** fail the payment: the customer may still
have been debited, and only reconciliation can settle that. It is recorded
loudly instead.

`settleConfirmedPayment` calls POS *before* marking the payment `paid`, because
POS's `markPaid` is idempotent. If POS is down the payment stays `confirmed`
with `pos_sync_error` set — visible, and recoverable. The callback returns a
non-2xx so Daraja retries rather than believing we handled it.

### The sweeper

`POST /internal/v1/pos-sync/sweep` re-drives everything that fell behind:
`confirmed` payments whose `paid` call never landed, and `pending` payments
whose `awaiting-payment` call never landed. It only repeats calls the contract
defines as idempotent, so it is safe to run at any time and a second run is a
no-op. Query `pos_sync_error IS NOT NULL` to see what is currently out of sync.

## Contract test

`test/contract-pos-live.contract.js` boots the **real** `services/pos` Express
app against a real POS database and points the real `createPosClient` at it over
HTTP. Every other test uses an in-memory fake POS, which proves our logic but
not that our client matches what POS actually serves — this one would catch a
renamed field, a changed status code, or a different auth header before the
joint G2 evidence run rather than during it.

```bash
cd services/pos      && docker compose up -d --wait && npm ci && npm run migrate
cd services/payments && docker compose up -d --wait && npm run migrate

DATABASE_URL=postgres://payments:payments@127.0.0.1:5434/tillflow_payments \
POS_DATABASE_URL=postgres://pos:pos@127.0.0.1:5433/tillflow_pos \
  npm run test:contract
```

It runs in CI on every PR that touches `services/payments/**` or
`services/_shared/**`.

One wrinkle worth knowing: the test builds POS's logger with
`require('../../pos/node_modules/pino')`. POS's `pino-http` breaks on a logger
instance created by Payments' own pino copy, because pino identifies loggers by
internal symbols that differ between installs.

## G2 trace evidence

The G2 proof is invariant tests **and** a trace. The tests are done; the trace
has to be captured from the live API once POS and Payments are both on ECS.

### What is already proven

`test/trace-propagation.contract.js` boots POS and Payments as two real OS
processes with OTel enabled, exports to a throwaway in-process OTLP collector,
drives the happy path, and asserts that POS and Payments spans share **one**
trace id and that POS's spans have a parent. Last local run: 102 spans across
`payments + pos` on a single trace.

This matters because context has to survive the Payments → POS hop, which goes
over `fetch`. That works only because `@opentelemetry/auto-instrumentations-node`
pulls in `@opentelemetry/instrumentation-undici`. If that instrumentation is
ever dropped, the G2 trace silently becomes *two disconnected traces* — which
you would otherwise discover during the demo.

### Capturing the evidence

`npm run evidence:g2` drives the full scripted happy path against any two base
URLs, with a caller-generated `traceparent` so the trace id is known up front
and can be looked up in X-Ray or Grafana afterwards.

```bash
# Same public API Gateway URL — ALB path-routes to POS vs Payments.
API_URL=$(cd ../../infra && terraform output -raw api_gateway_url)
POS_BASE_URL=$API_URL \
PAYMENTS_BASE_URL=$API_URL \
TENANT_ID=<uuid> ATTENDANT_ID=<uuid> \
POS_SERVICE_TOKEN=... DARAJA_CALLBACK_SECRET=... \
  npm run evidence:g2
```

It runs: create sale → replay the sale key → charge → replay the charge key →
callback → replay the callback → read final state, asserting one sale, one
charge, one `paid_at`, and no second STK. It writes a JSON summary to
`evidence/payments-integrity/g2-happy-path-<trace>.json` and exits non-zero if
any check fails.

**Only a run against the live API counts as G2 evidence.** A local run proves
the script works; it does not prove the deployed system does. Nothing is
committed to `evidence/` until it comes from the real thing — point
`EVIDENCE_DIR` somewhere else for local runs.

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
| `DATABASE_URL` | — | local/CI |
| `DB_SECRET_ID` | — | ECS: `devops-g10/db/payments` (Secrets Manager) |
| `MPESA_MODE` | `fake` | `daraja` only at G3 |
| `DARAJA_CALLBACK_SECRET` | from `devops-g10/service-tokens` | HMAC key |
| `DARAJA_CALLBACK_URL` | API GW `/payments/callback` | set by platform |
| `POS_BASE_URL` | internal ALB DNS | Payments → POS in-VPC |
| `PAYMENTS_SERVICE_TOKEN` | from `devops-g10/service-tokens` | what we present to POS |
| `POS_SERVICE_TOKEN` | from `devops-g10/service-tokens` | what POS presents to us |
| `COMMISSION_SERVICE_TOKEN` | from `devops-g10/service-tokens` | what Commission presents to us |
| `MPESA_B2C_SHORTCODE` | `600000` | |
| `POS_TIMEOUT_MS` | `3000` | per-request timeout on POS calls |

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
