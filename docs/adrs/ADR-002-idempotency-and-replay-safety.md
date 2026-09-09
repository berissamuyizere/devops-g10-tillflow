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

## Proof

- Invariant tests required at **G2**: replayed sale creation yields one
  sale; duplicate and out-of-order callbacks yield one charge and no
  illegal transition; a timeout leaves the payment `pending`, not
  `failed`; a re-run daily close yields one ledger entry and one payout.
- A distributed trace at **G2** covering the full
  sale -> payment -> callback/reconciliation flow, showing the retry path
  collapsing onto the same sale and payment IDs.
