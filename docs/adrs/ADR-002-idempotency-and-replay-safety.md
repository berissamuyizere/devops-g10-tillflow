# ADR-002 — Idempotency and replay safety for payments and commission

- **Status:** Accepted
- **Owner:** Arsema (Payments + integrity)
- **Date:** 2026-09-09
- **Area:** Payments + integrity

## Context

TillFlow charges real money through Daraja (M-Pesa) and pays agents from
those charges. Retries are unavoidable: clients resubmit sales, Daraja
callbacks arrive late, duplicated, or out of order, a timeout tells us
nothing about whether the customer was actually debited, and scheduled
jobs get re-run. Without an explicit rule, any of these can produce a
double charge, a double payout, or a sale wrongly marked failed.

## Decision

- **Sale creation is idempotent.** The client supplies an idempotency key
  with every sale request, stored under a unique DB constraint. A repeat
  of the same key returns the original sale instead of creating a second.
- **Payments are a state machine:** `initiated -> pending -> confirmed ->
  paid`, plus terminal `failed` and `timed_out`. A Daraja timeout moves
  the payment to `pending`/unknown — never `failed` — because absence of a
  response is not evidence of non-payment; only reconciliation or a
  callback resolves it.
- **Callbacks re-affirm, never re-transition.** A repeated or out-of-order
  callback matching the current state is acknowledged as a no-op; one that
  implies an illegal transition is rejected and logged. No callback can
  trigger a second charge.
- **Commission follows the same rule.** Payouts are calculated only from
  sales whose payment reached `paid`, written to a payout ledger with
  their own idempotency key (unique per agent per period), and disbursed
  via B2C through the Payments API only — never a direct Daraja call from
  Commission. A replayed daily-close job finds the existing ledger entry
  and creates neither a second entry nor a second payout.

## Alternatives considered

- **Rely on Daraja's own deduplication.** Rejected: that is an external
  guarantee we can neither verify nor enforce, and it gives us nothing to
  test or prove at grading. Our correctness cannot depend on a third
  party's undocumented behavior.
- **At-least-once processing without a state machine.** Rejected: with no
  recorded state, a handler cannot distinguish "already handled" from
  "new", so every retry is either a potential double charge or a dropped
  payment.

## Consequences

- Sales, payments, and the payout ledger each carry an idempotency key
  column with a unique index; writes use insert-or-return semantics.
- Payment transitions go through a single guarded function; illegal
  transitions raise rather than silently overwrite state.
- `pending`/`timed_out` payments need a reconciliation path (query Daraja
  status, then settle) — unresolved payments are visible, not invisible.
- Commission depends on the Payments API for disbursement, making Payments
  the only service holding Daraja credentials.

## Addendum — real Daraja does not sign callbacks (2026-09-20)

The G3 sandbox contract test confirmed the adapter speaks to the real Safaricom
sandbox: OAuth, STK push accepted, STK query answered, and the UTC timestamp our
adapter builds was accepted (Safaricom's own examples use EAT, so this was worth
checking). Evidence:
[`evidence/payments-integrity/g3-daraja-contract.json`](../../evidence/payments-integrity/g3-daraja-contract.json).

**The deployed service nevertheless stays on `MPESA_MODE=fake`.** Safaricom does
not sign its callbacks — no HMAC, no mTLS, no signed payload. Our callback
handler authenticates with an HMAC over the raw body, which the fake adapter
produces, so a real Daraja callback would be rejected with
`signature_header_malformed`. Switching the deployed service to `daraja` without
first replacing that mechanism would mean either dropping every real callback or
removing the check that stops forged ones marking a sale paid.

Neither is acceptable, so the switch waits on an explicit decision about
callback authenticity — an unguessable per-payment callback path, an IP
allowlist at WAF, or a signing shim at our own edge. See the "Callback
authenticity" section of [docs/threat-model.md](../threat-model.md).

B2C is also not exercised against the sandbox: it needs a public `ResultURL` and
`QueueTimeOutURL` registered with Safaricom, which is the same unsolved problem
in another shape.

The query in the contract run returned result code **1037**, "DS timeout user
cannot be reached" — the exact case this ADR is about, now observed from real
Daraja rather than the fake.

## Addendum — closing the two gaps this design left open (2026-09-21)

The G4 drill and a comparison against another team's implementation made two
gaps concrete. Both are now closed in code, and neither changes the position
this ADR takes.

### 1. A callback path that real Daraja can actually authenticate

The HMAC scheme in this ADR only works because our own scripts sign the
callbacks. Safaricom does not sign, so switching `MPESA_MODE` to `daraja`
would have made every inbound callback 401. That was recorded as an accepted
residual; it is now fixed rather than accepted.

`POST /callbacks/mpesa/:secret` authenticates on a secret path segment
compared in constant time, with an optional source-IP allowlist
(`DARAJA_CALLBACK_IP_ALLOWLIST`, e.g. `196.201.212.0/24`). The HMAC route
stays as it is, so nothing that works today changes.

Everything that does not depend on the transport still applies to both routes:
the `CheckoutRequestID` must match a push we initiated, the amount must match,
the state machine still refuses illegal transitions, and every rejection is
still written to `callback_log`.

A secret in a URL is weaker than a signature in a header — it appears in
access logs, proxies and tunnel inspectors, where an HMAC header does not.
It is the right answer only because the provider gives us no alternative.
Operationally that means the path secret must be scrubbed from ALB access
logs and rotated like any other credential.

### 2. Reconciliation that runs without a human

Reconciliation existed but only ran when somebody called the endpoint by
hand. The G4 drill is exactly where that showed: reconcile answered
`still_processing` and nothing ever asked again, so the payment stayed
uncertain indefinitely and `payments-oldest-pending` could never recover.

`reconcile-sweep.js` periodically reconciles `pending` payments older than
`RECONCILE_MIN_AGE_MS`, in batches, off `RECONCILE_SWEEP_ENABLED`. It queries
the provider and never re-sends a push, so it cannot double-charge. It does
not use an advisory lock: `pg_try_advisory_lock` is session-scoped and our
queries run on a pooled connection, so a lock and its unlock can land on
different connections. Safety comes instead from `reconcilePayment`, which
locks the payment row and re-checks its status inside a transaction. Two
tasks sweeping concurrently may both ask the provider, but only one can
transition the payment — asserted in `reconcile-sweep.test.js`.

This does not weaken the central claim. Silence is still not a decline: the
sweep leaves an unanswered payment `pending`, with no `failure_reason` and no
`timed_out_at`. It only means we now keep asking instead of waiting to be
told.

### Not done here

Deploying either of these needs environment variables added to the task
definitions (`DARAJA_CALLBACK_PATH_SECRET`, `DARAJA_CALLBACK_IP_ALLOWLIST`,
`RECONCILE_SWEEP_ENABLED`), which lives in the platform area. Until that
happens the sweep stays off and the secret path stays unconfigured, and an
unconfigured path secret fails closed with a 500, never an accidental 200.

## Proof

- Invariant tests required at **G2**: replayed sale creation yields one
  sale; duplicate and out-of-order callbacks yield one charge and no
  illegal transition; a timeout leaves the payment `pending`, not
  `failed`; a re-run daily close yields one ledger entry and one payout.
- A distributed trace at **G2** covering the full
  sale -> payment -> callback/reconciliation flow, showing the retry path
  collapsing onto the same sale and payment IDs.
