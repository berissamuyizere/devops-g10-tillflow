# Alerts — TillFlow (Y5 contract)

**Owner (DRI):** Saloi (Reliability + operations)
**Implemented in AWS by:** Yordanos (Y5 — CloudWatch alarms on SNS
`devops-g10-alerts`)
**Date:** 2026-09-20

This is the table Y5 implements. Do not invent extra alarm names. Names
follow [`docs/naming.md`](naming.md): `devops-g10-<signal>`. Every alarm
**must** set both `alarm_actions` and `ok_actions` to SNS
`devops-g10-alerts` so Slack posts **firing and recovered**.

Put the Slack contract in `alarm_description` as JSON (Lambda already
parses it — `infra/lambda/slack_notifier/index.py`):

```json
{
  "environment": "prod",
  "service": "pos",
  "symptom": "POS fast burn > 1.44%",
  "slo_impact": "POS sale-write SLI; 28d budget 40m19s",
  "observed": "see NewStateReason",
  "grafana_panel": "https://<amg>/d/tillflow-pos?viewPanel=2",
  "runbook": "https://github.com/berissamuyizere/devops-g10-tillflow/blob/main/docs/runbook.md#pos-fast-burn",
  "owner": "Berissa",
  "first_safe_action": "curl POS /health then /ready. Do not bounce RDS."
}
```

`treat_missing_data = "notBreaching"` unless noted. Region `eu-central-1`.
App metrics: namespace `TillFlow` (EMF). Use metric math + `SEARCH` so extra
OTel dimensions do not miss the series. `/health` and `/ready` are excluded
from SLI math ([`slo-error-budgets.md`](slo-error-budgets.md)).

**Page vs ticket:** fast burn + probe-down + oldest-pending + DLQ +
payout-not-settled → **page** (tone `danger`). Slow burn → **ticket**
(tone `warning`). Recovery is always posted (tone recovered).

CPU autoscale target is **70%** (ADR-005). That is also the saturation
alarm line.

## Y5 must-have

| Alarm name | Metric math / source | Threshold | Periods | Owner | Runbook |
|---|---|---|---|---|---|
| `devops-g10-web-fast-burn` | ALB web TG: `HTTPCode_Target_5XX_Count / (RequestCount - HTTPCode_Target_4XX_Count)` | > **0.0144** (1.44%) | 1 × 300s | Yordanos | [#web-fast-burn](runbook.md#web-fast-burn) |
| `devops-g10-web-slow-burn` | same | > **0.006** (0.6%) | 1 × 1800s | Yordanos | [#web-slow-burn](runbook.md#web-slow-burn) |
| `devops-g10-pos-fast-burn` | `TillFlow` `pos_sale_writes_total`: `error / (created + replay + error)` | > **0.0144** | 1 × 300s | Berissa | [#pos-fast-burn](runbook.md#pos-fast-burn) |
| `devops-g10-pos-slow-burn` | same | > **0.006** | 1 × 1800s | Berissa | [#pos-slow-burn](runbook.md#pos-slow-burn) |
| `devops-g10-payments-fast-burn` | `payments_commands_total`: `timeout / (accepted + timeout)` | > **0.072** (7.2%) | 1 × 300s | Arsema | [#payments-fast-burn](runbook.md#payments-fast-burn) |
| `devops-g10-payments-slow-burn` | same | > **0.03** (3%) | 1 × 1800s | Arsema | [#payments-slow-burn](runbook.md#payments-slow-burn) |
| `devops-g10-commission-fast-burn` | `commission_close_runs_total`: `error / (success + error)` | > **0.144** (14.4%) | 1 × 300s | Berissa | [#commission-fast-burn](runbook.md#commission-fast-burn) |
| `devops-g10-commission-slow-burn` | same | > **0.06** (6%) | 1 × 1800s | Berissa | [#commission-slow-burn](runbook.md#commission-slow-burn) |
| `devops-g10-probe-down` | `CloudWatchSynthetics` `SuccessPercent` dimensions `CanaryName=devops-g10-probe` | < **100** (Average) | 2 × 60s | Yordanos | [#probe-down](runbook.md#probe-down) |
| `devops-g10-payments-oldest-pending` | `TillFlow` `payments_oldest_pending_age_seconds` (any `kind`) | > **60** seconds | 1 × 60s | Arsema | [#payments-oldest-pending](runbook.md#payments-oldest-pending) |
| `devops-g10-commission-dlq` | SQS `ApproximateNumberOfMessagesVisible` on `devops-g10-commission-close-dlq` | ≥ **1** | 1 × 60s | Berissa | [#commission-dlq](runbook.md#commission-dlq) |
| `devops-g10-payout-not-settled` | Metric math: after **03:30 UTC**, `payouts_by_status` where `status` is `pending` or `disbursing` still > 0. Implement as a cron EventBridge rule 03:31 UTC that publishes to `devops-g10-alerts` if the gauge is non-zero, **or** a CloudWatch alarm with `period=86400` evaluated at 03:35 UTC. | > **0** at 06:30 EAT | once per day | Berissa + Arsema | [#payout-not-settled](runbook.md#payout-not-settled) |

SEARCH examples Y5 can paste:

```
e1 = SEARCH('{TillFlow} MetricName="pos_sale_writes_total" outcome="error"', 'Sum', 300)
e2 = SEARCH('{TillFlow} MetricName="pos_sale_writes_total" outcome="created"', 'Sum', 300)
e3 = SEARCH('{TillFlow} MetricName="pos_sale_writes_total" outcome="replay"', 'Sum', 300)
error_rate = e1 / (e1 + e2 + e3)
```

```
t = SEARCH('{TillFlow} MetricName="payments_commands_total" outcome="timeout"', 'Sum', 300)
a = SEARCH('{TillFlow} MetricName="payments_commands_total" outcome="accepted"', 'Sum', 300)
error_rate = t / (t + a)
```

If a denominator is 0, treat as not breaching (no traffic ≠ burn).

## Also page (same SNS path)

| Alarm name | Source | Threshold | Periods | Owner | Runbook |
|---|---|---|---|---|---|
| `devops-g10-payments-callbacks-dlq` | SQS `ApproximateNumberOfMessagesVisible` on `devops-g10-payments-callbacks-dlq` | ≥ **1** | 1 × 60s | Arsema | [#payments-callbacks-dlq](runbook.md#payments-callbacks-dlq) |
| `devops-g10-ecs-cpu-high` | `AWS/ECS` `CPUUtilization` Average, cluster `devops-g10`, any of services `devops-g10-web`, `devops-g10-pos`, `devops-g10-payments`, `devops-g10-commission` | > **70%** | 2 × 300s | Yordanos | [#ecs-cpu-high](runbook.md#ecs-cpu-high) |
| `devops-g10-rds-cpu-high` | `AWS/RDS` `CPUUtilization` on `devops-g10-pg` | > **70%** | 2 × 300s | Yordanos | [#rds-cpu-high](runbook.md#rds-cpu-high) |

Autoscale target tracking for ECS services is **70% CPU** (ADR-005). The
alarm above is the page when tracking fails to keep up.

## Notification path (already in Terraform)

```
CloudWatch alarm (ALARM and OK)
        │
        ▼
 SNS topic devops-g10-alerts
        │
        ▼
 Lambda  devops-g10-slack-notifier
        │  reads devops-g10/slack-webhook (Secrets Manager only)
        ▼
 Slack, contract fields, firing AND recovered
```

Webhook is **never** in Git, TF vars, or Lambda environment. Saloi
populates it out of band — see [runbook § Slack webhook](runbook.md#slack-webhook).

## Out of scope for Y5

- Grafana-side burn alerts (panels are Saloi; pager is CloudWatch).
- Tuning thresholds after k6 (written rationale in this file).
- Merging [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).

## Related

- [runbook.md](runbook.md)
- [slo-error-budgets.md](slo-error-budgets.md)
- [ADR-005](adrs/ADR-005-observability.md)
