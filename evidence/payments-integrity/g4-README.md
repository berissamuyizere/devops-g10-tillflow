# G4 — Payments integrity drills

Two timed drills, run against the live stack from inside the VPC with
`evidence/run-in-vpc.sh payments scripts/g4-payment-drills.js`.

| Drill | File | Result |
|---|---|---|
| Uncertain payment (Daraja timeout) | `g4-uncertain-payment.json` | 14/14 |
| Callback replay and reorder | `g4-callback-replay.json` | 11/11 |

Run window: 2026-09-20T21:04:46Z to 21:07:22Z. Payments task definition `:22`.

X-Ray: `1-6ab04a83-51f89325d6a4c8bb357ec100` (uncertain),
`1-6ab04ade-62ce0ae5e4d8efd05f4a25a2` (replay).

## Drill 1 — uncertain payment

Fault: charge `254700000003`, the payer the fake adapter answers with a push
timeout. Held 90s, then recovered.

Daraja went silent, so the payment stayed `pending` with no `failure_reason`
and kept its `checkout_request_id`. After the hold it was still `pending` and
had never been `failed` or `timed_out`. The first safe action is reconcile,
which queries Daraja and never re-sends: it answered 200 with
`still_processing`, which is the honest answer while Daraja has said nothing.
A retry of the same charge was refused 409 `PAYMENT_ALREADY_EXISTS` and named
the existing payment, so an impatient attendant cannot open a second charge.

## Drill 2 — callback replay and reorder

The success callback moved the payment to `paid`. A byte-identical replay was
absorbed as a no-op and still returned 200. A late 1032 decline arriving after
the success was refused 409 `illegal_transition`, naming `paid` as what it
refused to leave. Afterwards `paid_at` had not moved and there was still
exactly one receipt.

## A defect this drill found

The first run failed on reconcile with a 500. The fake Daraja adapter kept
in-flight pushes in a per-process `Map`, and Payments runs two tasks, so a
reconcile load-balanced to the task that did not serve the charge could not
find the `checkoutRequestId`. The invariants held, but the documented recovery
action did not work. Fixed in PR #130: `stkQuery` rebuilds the entry from the
request fields, and only when they re-derive that exact id. The run recorded
here is against the fixed image.

## Honest note on detection

`devops-g10-payments-oldest-pending` was already in ALARM when this drill
started, since 2026-09-20T17:13:37Z, with the oldest pending payment about
3h55m old and climbing 60s per minute. So there is no clean OK to ALARM to OK
transition to show for this window.

The cause is not a fault. In fake mode the timeout payer's `stkQuery` answers
1100 forever, so those payments can never be reconciled out of `pending`, and
they accumulate across every G2, G3 and G4 run. This drill's payment joins them
by design: ADR-002 holds that silence is not a decline, so an uncertain payment
stays `pending` until Daraja speaks.

The consequence is worth stating rather than hiding: this alarm cannot recover
on its own while the service runs in fake mode. It fires on exactly the
condition the drill creates, which is the detection proof; recovery would need
either a real Daraja that eventually answers, or a decision about how long a
pending payment may stay uncertain before an operator resolves it by hand.
