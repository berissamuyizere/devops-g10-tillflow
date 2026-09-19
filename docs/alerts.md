# Alerts — TillFlow

**Owner (DRI):** Saloi (Reliability + operations)
**Implemented in AWS by:** Yordanos (G2 `infra/services.tf` and the
alarm/SNS/Lambda stub in [platform-asks-g2.md](platform-asks-g2.md))
**Date:** 2026-09-11

Every row pages Slack with the [runbook contract](runbook.md#slack-alert-contract)
and a `#anchor` in [`docs/runbook.md`](runbook.md). Names follow
[`docs/naming.md`](naming.md): `devops-g10-<signal>`.

Thresholds are starter values. They may move before final benchmarking
only with a written rationale, same rule as
[`slo-error-budgets.md`](slo-error-budgets.md).

`/health` and `/ready` are **excluded** from SLI numerators (ADR-004).
They are still what the synthetic probe and the first safe action hit.

## Minimum set (G3)

| Alert name | CloudWatch name | SLI | Threshold | First action | Runbook |
|---|---|---|---|---|---|
| `pos-5xx` | `devops-g10-pos-5xx` | POS: valid sale writes accepted exactly once. Success ≥ 99.9%, p95 < 400ms. | 5xx ratio on POS target group > 2% for 5 minutes, **or** p95 > 400ms for 10 minutes. Exclude 4xx. | curl POS `/health` then `/ready`. `/health` 200 + `/ready` 503 → dependency, not the task. | [#pos-5xx](runbook.md#pos-5xx) |
| `payments-callback-lag` | `devops-g10-payments-callback-lag` | Payments: eligible STK/B2C accepted + callback processed within 60s. ≥ 99.5%. | p95 (`callback_applied_at - stk_accepted_at`) > 60s for 5 minutes, **or** any `pending` payment older than 5 minutes. | Do not mark `failed`. Reconcile `pending` rows. Timeout stays `pending`. | [#payments-callback-lag](runbook.md#payments-callback-lag) |
| `commission-late-payout` | `devops-g10-commission-late-payout` | Commission: eligible payouts terminal by 06:30 EAT; duplicate disbursement = 0. ≥ 99.0%. | After 03:30 UTC (06:30 EAT), yesterday's `payout_ledger` still has non-terminal rows, **or** EventBridge `devops-g10-commission-daily-close` missed its 20:45 UTC fire. | Confirm the rule fired and `desiredCount >= 1`. Do not replay daily close until the `(agent_id, period)` row is in hand. | [#commission-late-payout](runbook.md#commission-late-payout) |
| `sqs-dlq-nonempty` | `devops-g10-sqs-dlq-nonempty` | Async backing the money path. A silent DLQ hides SLO misses. | `ApproximateNumberOfMessagesVisible >= 1` on `devops-g10-payments-callbacks-dlq` **or** `devops-g10-commission-close-dlq` for 1 minute. | Read, do not redrive, until the failure class is known. | [#dlq-nonempty](runbook.md#dlq-nonempty) |
| `sidecar-not-running` | `devops-g10-sidecar-not-running` | Observability availability. ADOT is `essential=false`; the app stays up while traces die. | For any backend service, `adot` container not `RUNNING` while `app` is `RUNNING`, for 5 minutes. | Describe the task. Fix SSM `/devops-g10/adot/config`; do not flip `essential=true`. | [#sidecar-not-running](runbook.md#sidecar-not-running) |
| `rds-cpu-high` | `devops-g10-rds-cpu-high` | Saturation of shared Postgres (`db.t4g.micro`). Leading indicator for POS p95 and callback time. | RDS `CPUUtilization` > 70% for 10 minutes on `devops-g10-pg`. | Performance Insights → noisy query. No console failover, no console instance-class change. | [#rds-cpu-high](runbook.md#rds-cpu-high) |
| `alb-5xx` | `devops-g10-alb-5xx` | Edge availability in front of web / POS / Payments. Burns Web + POS 0.1% budgets. | ALB `HTTPCode_Target_5XX_Count + HTTPCode_ELB_5XX_Count` ≥ 5 in 5 minutes **or** 5xx ratio > 1% for 5 minutes. | Split target vs ELB 5xx. Target → service runbook. ELB → healthy-target count. | [#alb-5xx](runbook.md#alb-5xx) |

## Probe that is not a service SLI (still pages)

| Alert name | CloudWatch name | SLI | Threshold | First action | Runbook |
|---|---|---|---|---|---|
| `external-health` | `devops-g10-external-health` | External synthetic: Route 53 health check against API Gateway `GET /health`. Detects "VPC is fine, the internet path is not." | Health check status `Unhealthy` for 2 consecutive 30s intervals (~1 minute). | Check API Gateway + WAF + VPC Link before blaming ECS. Then `#alb-5xx`. | [#alb-5xx](runbook.md#alb-5xx) |

This probe is **platform ask #1**. It does not burn the POS/Payments
numerator (`/health` is excluded); it is the "are we reachable from
outside" signal for G3 and the G5 demo.

## Metric sources

| Alert | Metric (G2/G3) | Fallback until the app metric exists |
|---|---|---|
| `pos-5xx` | ALB target-group `HTTPCode_Target_5XX_Count` for POS | Web target group until POS is on the ALB |
| `payments-callback-lag` | EMF `TillFlow` / `callback_lag_ms` (Payments) | Count of `pending` payments via a scheduled metric filter on `/devops-g10/payments` |
| `commission-late-payout` | EMF `TillFlow` / `payout_terminal_by_0630` | EventBridge `FailedInvocations` + ECS `RunningTaskCount` for commission |
| `sqs-dlq-nonempty` | SQS `ApproximateNumberOfMessagesVisible` | — (exists at G1) |
| `sidecar-not-running` | Container Insights `ContainerName=adot` running count | ECS `DescribeTasks` via a 1-min EventBridge → Lambda until Insights is trusted |
| `rds-cpu-high` | `AWS/RDS` `CPUUtilization` on `devops-g10-pg` | — (exists at G1) |
| `alb-5xx` | `AWS/ApplicationELB` 5xx on `devops-g10-alb` | — (exists at G1) |
| `external-health` | `AWS/Route53` `HealthCheckStatus` | — (ask #1) |

## Notification path

```
CloudWatch alarm
        │
        ▼
 SNS topic devops-g10-alerts   (no email, no chatbot)
        │
        ▼
 Lambda  devops-g10-slack-notify
        │  reads devops-g10/slack-webhook
        ▼
 Slack, contract fields only
```

The stub alarm (ask #3) exercises this path **before** any real
threshold fires, so G3 is not the first time we learn the webhook is
still `PLACEHOLDER`.

## Related

- [runbook.md](runbook.md)
- [ADR-005](adrs/ADR-005-observability.md)
- [platform-asks-g2.md](platform-asks-g2.md)
- [slo-error-budgets.md](slo-error-budgets.md)
