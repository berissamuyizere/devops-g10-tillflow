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

## Proof

- Invariant tests required at **G2**: replayed sale creation yields one
  sale; duplicate and out-of-order callbacks yield one charge and no
  illegal transition; a timeout leaves the payment `pending`, not
  `failed`; a re-run daily close yields one ledger entry and one payout.
- A distributed trace at **G2** covering the full
  sale -> payment -> callback/reconciliation flow, showing the retry path
  collapsing onto the same sale and payment IDs.
