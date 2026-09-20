# G2 HOLD resubmission — TillFlow

**From:** Saloi (Reliability + operations), for Group 10  
**Date:** 2026-09-20  
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

This is the cover for the second G2 HOLD. The money-path fixes from the first HOLD stay as they were. This pass is the public edge and a close that still works after that edge is locked.

## What shipped

| Item | Pointer |
|---|---|
| Fix PR | [#64](https://github.com/berissamuyizere/devops-g10-tillflow/pull/64) — hide `/internal` from the internet; daily close at 01:00 EAT |
| SHA on `main` when the lockdown went live | `f810a2cea189cbe607d1ea67459eeaadb3f46508` ([#61](https://github.com/berissamuyizere/devops-g10-tillflow/pull/61) `develop` → `main`) |
| How | API Gateway stamps forwarded requests `x-tillflow-edge: public`. ALB priority-1 returns `404 {"error":"not_found"}` for stamped `/internal/*`. Service-to-service calls omit the stamp and still reach POS/Payments. |
| Daily close | EventBridge `devops-g10-commission-daily-close` is `cron(0 22 * * ? *)` (22:00 UTC = 01:00 EAT). |

## Evidence to open

### 1. Public edge — 404 / 404 / 401 / 200

[`evidence/platform-delivery/g2-edge-lockdown.txt`](../evidence/platform-delivery/g2-edge-lockdown.txt)

Captured 2026-09-20 08:36 UTC through

`https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com`

| Call | HTTP | Body |
|---|---|---|
| `GET /internal/v1/payments/00000000-0000-0000-0000-000000000001` | **404** | `{"error":"not_found"}` |
| `POST /internal/v1/payouts` | **404** | `{"error":"not_found"}` |
| `POST /payments/callback` (unsigned) | **401** | `signature_header_malformed` |
| `GET /health` | **200** | `{"status":"ok","service":"web"}` |

A laptop can no longer create a payout. That is the point of the HOLD.

### 2. Close → payout → B2C after that lockdown

[`evidence/payments-integrity/g2-close-b2c-post-release.json`](../evidence/payments-integrity/g2-close-b2c-post-release.json)

`passed: true` (20 / 20). Run started 2026-09-20 09:29 UTC against the **internal ALB**, `MPESA_MODE=fake`, `triggered_via: sqs_manual`, period **`2026-09-20`**.

The script waits in-VPC (`evidence/run-in-vpc.sh`). SQS `commission.daily-close` with `"business_day":"2026-09-20"` is sent from a laptop (Payments cannot `SendMessage` to that queue). Same body again for replay: same ledger row, no second B2C. Timeout payout stays `disbursing`.

Seed for that attendant: [`evidence/product-pos/g2-seed-55555555.json`](../evidence/product-pos/g2-seed-55555555.json).

This JSON was captured after Release [35502129083](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35502129083) on `d3e822c` (payments image with the in-VPC evidence-script fixes). The lockdown from `f810a2cea189cbe607d1ea67459eeaadb3f46508` was already live; that later Release did not reopen `/internal`.

### 3. Commission worker received both SQS messages

[`evidence/payments-integrity/g2-commission-worker-logs-post-release.json`](../evidence/payments-integrity/g2-commission-worker-logs-post-release.json)

CloudWatch `/devops-g10/commission` for the same window. Two `close_message_received` lines, then `close_eligible` / `close_message_deleted` for each:

| `message_id` | UTC | `msg` |
|---|---|---|
| `0741fcbf-3008-406e-bf29-e73908aa2255` | 09:34:13 | `close_message_received` (first close) |
| `8bd3bd4e-302c-443c-a536-1d4747d448ce` | 09:34:23 | `close_message_received` (replay) |

Both `close_eligible` lines are tenant `11111111-…`, period `2026-09-20`. Task `553f78ac814c4627b8a18eaac8b7dfc8` is the live `devops-g10-commission` worker ([`ecs-commission-tasks.json`](../evidence/platform-delivery/ecs-commission-tasks.json)).

## What we are not claiming

- Real Daraja. `MPESA_MODE=fake` for this proof. Sandbox adapter is G3 ([#59](https://github.com/berissamuyizere/devops-g10-tillflow/pull/59), still open).
- Grafana / k6 / game day. That is G3–G4.
- A further `develop` → `main` to copy these evidence files. Live AWS already matches the lockdown SHA above.

Berissa will send this file to Rob once all four have approved the PR.
