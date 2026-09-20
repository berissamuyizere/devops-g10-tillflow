# SLOs and error budgets — TillFlow

**Owner (DRI):** Saloi (Reliability + operations)
**Date:** 2026-09-20

Targets may change only before final benchmarking, with a written rationale.

Invalid requests and genuine business declines are excludable. Dependency
outages during a real user journey are **not** excludable. `/health` and
`/ready` are excluded from every numerator and denominator (ADR-004).

Metric names are locked in [ADR-005](adrs/ADR-005-observability.md). **No
IDs in labels.** CloudWatch namespace is `TillFlow` (ADOT EMF).

## Freeze / resume

Copied here so Yordanos and the on-call do not have to open the ADR:

- **Budget gone** (remaining 28-day budget = 0) → freeze releases except
  fixes.
- **Resume** when remaining budget **> 25% for 24 hours**.
- Fast burn **pages** the owner. Slow burn **opens a ticket**. Thresholds
  and CloudWatch names: [`docs/alerts.md`](alerts.md).

## Web

- **Primary SLI:** Eligible page and API-shell loads that succeed.
- **Starter target:** Success rate ≥ 99.9% and p95 latency < 500ms.
- **28-day error budget:** 0.1% of eligible events, or 40m19s of downtime,
  per 28 days.
- **Denominator (eligible):** public API Gateway + ALB requests to the web
  target group that are not client 4xx. Probe `GET /health` is excluded.
- **Numerator (good):** eligible requests that return 2xx/3xx from the web
  target.
- **Error rate (burn):** `1 − good / eligible`. Fast > **1.44%**. Slow >
  **0.6%**.
- **CloudWatch:** `AWS/ApplicationELB` `RequestCount` and
  `HTTPCode_Target_5XX_Count` on `devops-g10-web-tg`. Uptime panels also
  use `CloudWatchSynthetics` `SuccessPercent` on canary `devops-g10-probe`.
- **Excluded events:** malformed client requests and
  unauthenticated/unauthorized calls. A failed page or API-shell load
  caused by a downstream dependency during a real user journey still burns
  budget.

## POS API

- **Primary SLI:** Valid sale writes accepted exactly once.
- **Starter target:** Success rate ≥ 99.9% and p95 latency < 400ms.
- **28-day error budget:** 0.1% of eligible events, or 40m19s of downtime,
  per 28 days.
- **Denominator (eligible):** `pos_sale_writes_total` where `outcome` is
  `created`, `replay`, or `error`. `rejected` (4xx / schema-invalid) is
  excluded.
- **Numerator (good):** `pos_sale_writes_total{outcome="created|replay"}`.
- **Latency:** `pos_sale_write_latency_ms` p95 on eligible writes; target
  < 400ms.
- **Error rate (burn):** `error / (created + replay + error)`. Fast >
  **1.44%**. Slow > **0.6%**.
- **Business signal (not the SLI):** `pos_sales_paid_total`.
- **Cache (not the SLI):** `pos_cache_requests_total{result=hit|miss|error}`.
  Cache `error` fail-opens to Postgres and does **not** burn this budget.
- **Excluded events:** schema-invalid or otherwise unprocessable sale
  payloads. A valid sale write that fails because a dependency is down
  during the cashier journey still burns budget.

## Payments API

- **Primary SLI:** Valid STK/B2C commands accepted and callbacks processed
  within 60s.
- **Starter target:** ≥ 99.5% of eligible commands complete (accepted +
  callback processed) within 60s.
- **28-day error budget:** 0.5% of eligible events, or 3h21m36s, per 28
  days.
- **Denominator (eligible):** `payments_commands_total` where `outcome` is
  `accepted` or `timeout`. `rejected` (invalid payload) is excluded.
  Genuine M-Pesa declines on an applied callback are excluded.
- **Numerator (good):** eligible commands whose callback is `applied` with
  `payments_callback_latency_ms` ≤ 60000.
- **Error rate (burn):** `timeout / (accepted + timeout)`, plus any
  accepted command whose oldest pending age exceeds 60s. Fast > **7.2%**.
  Slow > **3%**.
- **Lag signal:** `payments_oldest_pending_age_seconds{kind}`. Alert at
  > 60s.
- **Also watch:** `payments_callbacks_total{kind,outcome}` and
  `payouts_by_status{status}`.
- **Excluded events:** invalid STK/B2C payloads and genuine M-Pesa
  business declines (insufficient funds, user cancellation). A timeout or
  failure caused by Daraja or another dependency during a real payment
  journey still burns budget.

## Commission

- **Primary SLI:** Eligible payouts that reach a terminal state by 06:30
  EAT, with duplicate disbursement = 0.
- **Starter target:** ≥ 99.0% of eligible payouts reach a terminal state
  by 06:30 EAT; duplicate disbursement must remain 0.
- **28-day error budget:** 1% of eligible payout events, or 0.28 late
  runs, per 28 days. Any duplicate disbursement is an SLO miss (**no**
  budget).
- **Denominator (eligible):** `commission_payouts_requested_total` where
  `outcome` is `accepted`, `replay`, `conflict`, or `error`. `skipped`
  (ineligible) is excluded.
- **Numerator (good):** those payouts that are terminal
  (`payouts_by_status` `disbursed` or `failed` from a genuine business
  decline) by 06:30 EAT. `replay` of an existing ledger row is good.
  `conflict` that creates a second B2C is an SLO miss with no budget.
- **Close-run signal:** `commission_close_runs_total{outcome}`. Error
  rate for the worker: `error / (success + error)`. Fast > **14.4%**.
  Slow > **6%**.
- **Settled-by-0630 signal:** after 03:30 UTC, `payouts_by_status` must
  not still show `pending` or `disbursing` for yesterday's period.
- **Excluded events:** ineligible payouts (`skipped`) and genuine
  business declines of a payout. A late or failed disbursement caused by
  a payments or platform dependency during a real payout run still burns
  budget.

## Related

- [alerts.md](alerts.md) — CloudWatch names Yordanos implements as Y5
- [runbook.md](runbook.md) — first safe action per alarm
- [ADR-005](adrs/ADR-005-observability.md) — Grafana, metric names, k6, cache
