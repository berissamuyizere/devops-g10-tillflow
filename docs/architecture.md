# Architecture — TillFlow

**Status:** Accepted (G0)
**Owner (DRI):** Yordanos (Platform + delivery)
**Contributors:** Berissa (sale / POS flow), Arsema (payment / payout flow), Saloi (telemetry path)
**Date:** 2026-09-10
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

## System diagram

```
 Attendant / Owner browser
            │
            ▼
     ┌──────────────┐
     │  Web (ECS)   │  frontend / API shell
     └──────┬───────┘
            │ HTTPS
            ▼
     ┌──────────────┐
     │ API Gateway  │
     └──────┬───────┘
            │ VPC Link
            ▼
     ┌──────────────┐
     │     ALB      │  private subnets, 2 AZs
     └──┬───────┬───┘
        │       │
        ▼       ▼
   ┌────────┐ ┌──────────┐     ┌─────────────┐
   │  POS   │ │ Payments │     │ Commission  │  EventBridge 23:45 EAT
   │  API   │ │   API    │◄────│   worker    │  → SQS (no public ALB)
   └───┬────┘ └────┬─────┘     └─────────────┘
       │           │
       │           │ STK / B2C only
       │           ▼
       │     ┌──────────┐
       │     │  Daraja  │
       │     │ sandbox  │
       │     └──────────┘
       │
       ▼
 ┌─────────────────────────────────────────┐
 │  RDS PostgreSQL (service schemas)       │
 │  Redis/Valkey  ·  SQS + DLQ  ·  S3      │
 └─────────────────────────────────────────┘

 Every backend ECS task = application container + ADOT Collector sidecar
 ADOT → CloudWatch / Prometheus / X-Ray → Grafana
```

## Service boundaries

| Service | Owns | Does not own |
|---|---|---|
| **Web** | UI, API shell, auth session hand-off to APIs | Sale persistence, Daraja, payouts |
| **POS API** | Tenant, till id, attendants, roles, sale + line items, sale status (`created` → `awaiting_payment` → `paid` / `cancelled`) | Daraja credentials, STK/B2C, payout ledger |
| **Payments API** | Daraja auth, STK Push, callbacks, query/reconcile, B2C, payment state machine | Creating sales, changing sale totals, calling Commission |
| **Commission worker** | Daily close, eligibility from `paid` sales, payout ledger, B2C *requests* through Payments | Direct Daraja calls, unpaid sales |
| **`_shared`** | M-Pesa adapter interface, OTel setup, Docker base | Business decisions |

RDS: one instance, **service-owned schemas/roles** (`pos`, `payments`, …). Money is integer KES minor units. Cache-aside via Redis/Valkey. SQS + DLQ for async work. Secrets (Daraja, Slack, DB) in Secrets Manager — never in Git.

Required tags on every AWS resource: `group`, `owner`, `environment`, `service`, `managed-by=terraform`, `capstone=tillflow`. Naming: [`docs/naming.md`](naming.md) and [ADR-001 region/naming](adrs/ADR-001-region-and-naming.md).

## Flow 1 — Sale → pay → callback

Decisions locked in [tenant/sale ADR](adr-001-tenant-sale-data-model.md) and [idempotency ADR](adrs/ADR-002-idempotency-and-replay-safety.md).

1. Attendant opens a sale in Web → `POST` POS with `Idempotency-Key`.
2. POS inserts sale + lines (`status=created`) or returns the existing sale for the same key. Same key + different body → `409`.
3. Web/POS asks Payments to charge `sale_id` for `total_minor` against the tenant till.
4. Payments records payment `initiated` → calls Daraja STK → moves to `pending`. POS moves sale to `awaiting_payment` only after Payments accepts the command.
5. Daraja callback (or query/reconcile) confirms success → Payments `pending` → `paid`. POS sets sale `paid` and `paid_at` once. Replay/out-of-order callback is a no-op or rejected illegal transition — never a second charge.
6. **Timeout is not a decline.** Payment stays `pending` / unknown until reconcile. Sale does not become `cancelled` or `paid` on timeout alone.

## Flow 2 — Daily close → commission → B2C

1. EventBridge `devops-g10-commission-daily-close` (`cron(45 20 * * ? *)` = 23:45 EAT) enqueues SQS `devops-g10-commission-close`.
2. The Commission ECS worker (no ALB) long-polls that queue, then `GET`s POS `/internal/v1/commission/eligible` for `status=paid` sales on that Africa/Nairobi business day.
3. For each attendant it `POST`s Payments `/internal/v1/payouts` with `X-Commission-Token` and `Idempotency-Key: <agent_id>:<period>`. Payments writes **one** payout-ledger row keyed by agent + period.
4. Replay of daily close is a `200` with `replay: true` (no second B2C). A `409` is not retryable.
5. Payments owns the B2C call and its result/timeout callbacks. Commission never holds Daraja credentials.

## Observability path

Apps export OTLP to the localhost ADOT sidecar. JSON logs carry `trace_id` / `span_id`. Target traces for G3: sale → payment → callback/reconcile, and scheduled commission → B2C. Grafana shows uptime, SLO target, budget burn, RED, and saturation ([`docs/slo-error-budgets.md`](slo-error-budgets.md)).

## Related decisions

| Decision | Doc |
|---|---|
| Region + naming | [ADR-001](adrs/ADR-001-region-and-naming.md) |
| Tenant / sale model | [ADR](adr-001-tenant-sale-data-model.md) |
| Idempotency + replay | [ADR-002](adrs/ADR-002-idempotency-and-replay-safety.md) |
| Draft SLOs | [slo-error-budgets.md](slo-error-budgets.md) |
| Threats | [threat-model.md](threat-model.md) |
