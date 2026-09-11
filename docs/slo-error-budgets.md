# SLOs and error budgets — TillFlow

Targets may change only before final benchmarking, with a written rationale.

These SLIs, targets, and 28-day error budgets will be wired into Grafana panels at G3 ([ADR-005](adrs/ADR-005-observability.md)). Pager mapping: [alerts.md](alerts.md). First safe action: [runbook.md](runbook.md).

Invalid requests and genuine business declines are excludable. Dependency outages during a real user journey are **not** excludable.

## Web

- **Primary SLI:** Eligible page and API-shell loads that succeed.
- **Starter target:** Success rate ≥ 99.9% and p95 latency < 500ms.
- **28-day error budget:** 0.1% of eligible events, or 40m19s of downtime, per 28 days.
- **Excluded events:** Malformed client requests and unauthenticated/unauthorized calls are excluded; a failed page or API-shell load caused by a downstream dependency during a real user journey still burns budget.

## POS API

- **Primary SLI:** Valid sale writes accepted exactly once.
- **Starter target:** Success rate ≥ 99.9% and p95 latency < 400ms.
- **28-day error budget:** 0.1% of eligible events, or 40m19s of downtime, per 28 days.
- **Excluded events:** Schema-invalid or otherwise unprocessable sale payloads are excluded; a valid sale write that fails because a dependency is down during the cashier journey still burns budget.

## Payments API

- **Primary SLI:** Valid STK/B2C commands accepted and callbacks processed within 60s.
- **Starter target:** ≥ 99.5% of eligible commands complete (accepted + callback processed) within 60s.
- **28-day error budget:** 0.5% of eligible events, or 3h21m36s, per 28 days.
- **Excluded events:** Invalid STK/B2C payloads and genuine M-Pesa business declines (e.g. insufficient funds, user cancellation) are excluded; a timeout or failure caused by Daraja or another dependency during a real payment journey still burns budget.

## Commission

- **Primary SLI:** Eligible payouts that reach a terminal state by 06:30 EAT, with duplicate disbursement = 0.
- **Starter target:** ≥ 99.0% of eligible payouts reach a terminal state by 06:30 EAT; duplicate disbursement must remain 0.
- **28-day error budget:** 1% of eligible payout events, or 0.28 late runs, per 28 days. Any duplicate disbursement is an SLO miss (no budget).
- **Excluded events:** Ineligible payouts and genuine business declines of a payout are excluded; a late or failed disbursement caused by a payments or platform dependency during a real payout run still burns budget.
