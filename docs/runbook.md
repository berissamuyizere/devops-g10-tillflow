# Runbook — TillFlow

**Owner (DRI):** Saloi (Reliability + operations)
**Cross-reviewer:** Yordanos
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

This is the G3 skeleton. Every CloudWatch alarm the platform ships must
link here. Fill Grafana panel URLs after the Managed Grafana workspace
lands ([ADR-005](adrs/ADR-005-observability.md)).

## On-call rotation

Primary answers Slack within 15 minutes during G3–G5 (16–21 Sep 2026).
Saloi is always secondary (reliability DRI). Hand-off is a Slack message
in the alerts channel naming the next primary.

| Date (EAT) | Primary | Secondary | Notes |
|---|---|---|---|
| Tue 16 Sep | Saloi | Yordanos | G3 start — first panels + Slack stub |
| Wed 17 Sep | Yordanos | Saloi | Platform smoke / rollback path |
| Thu 18 Sep | Arsema | Saloi | Payments callbacks + Daraja sandbox |
| Fri 19 Sep | Berissa | Saloi | POS sale path; game-day day 1 |
| Sat 20 Sep | Saloi | Arsema | Game-day day 2; RTO/RPO capture |
| Sun 21 Sep | all four | — | G5 defence; no solo changes |

Outside that window: the area DRI in [`ownership.md`](ownership.md) is
primary for their service. Cross-reviewer is secondary.

## Slack alert contract

Every page — including the G2 stub alarm — posts **exactly** these
fields. The helper is [`services/_shared/alerts/slack-notify.sh`](../services/_shared/alerts/slack-notify.sh).
Lambda must map CloudWatch → this payload; do not invent a second shape.

| Field | Required | Example |
|---|---|---|
| `environment` | yes | `prod` |
| `service` | yes | `pos` |
| `symptom` | yes | `HTTP 5xx > 2% for 5m` |
| `slo_impact` | yes | `POS sale-write SLI; 28d budget 40m19s` |
| `observed` | yes | `5xx ratio 4.1% (p95 820ms)` |
| `grafana_panel` | yes | dashboard URL + `viewPanel=` |
| `runbook` | yes | this file + `#anchor` |
| `owner` | yes | area DRI from CODEOWNERS |
| `first_action` | yes | the **first safe action** below, copied verbatim |

Tone is `info` (recovery), `warning` (budget burn, still serving), or
`danger` (user-facing break). Recovery messages use the same contract
with `symptom` prefixed `recovered:`.

```
slack-notify.sh <tone> <service> <symptom> <slo-impact> <observed> \
  <grafana-panel> <runbook-anchor> <owner> <first-action>
```

## How to page

1. Read the Slack fields. Do **not** start with a console click that
   Terraform does not own.
2. Jump to the matching `#anchor` below.
3. Do the first safe action. If it does not restore, escalate to the
   area DRI and capture timestamps in
   `evidence/reliability-operations/`.
4. Post a recovery message with the same contract when the alarm
   returns to OK.

k6 never goes through API Gateway (WAF is 200 req / 5 min / IP). Load
tests target the **internal ALB DNS** from inside the VPC — see
[`evidence/reliability-operations/k6/`](../evidence/reliability-operations/k6/).

---

## pos-5xx

- **Alarm:** `devops-g10-pos-5xx`
- **SLI:** Valid sale writes accepted exactly once
([`slo-error-budgets.md`](slo-error-budgets.md)).
- **Owner:** Berissa
- **First safe action:** `curl -sSf "$ALB/health"` and
  `curl -sSf "$ALB/ready"` against POS. If `/health` is 200 and `/ready`
  is 503, the process is up and a dependency is not — check RDS, not the
  task. If both fail, look at the last ECS deployment and prepare a
  rollback; do not bounce RDS.

Then: CloudWatch logs `/devops-g10/pos` for `unhandled_error`; confirm
the 5xx are not excluded client 4xx. If the last release is the
cause, Yordanos rolls back with
`aws ecs update-service --task-definition <previous>` (ADR-004).

## payments-callback-lag

- **Alarm:** `devops-g10-payments-callback-lag`
- **SLI:** Valid STK/B2C commands accepted and callbacks processed
within 60s.
- **Owner:** Arsema
- **First safe action:** Do **not** mark the payment `failed`. List
  `pending` payments older than 60s and run
  `POST /internal/v1/payments/:id/reconcile`. Timeout stays `pending`
  until reconcile or a callback ([ADR-002](adrs/ADR-002-idempotency-and-replay-safety.md)).

Then: check `payments.callback_log` for a burst of
`rejected_bad_signature` (forged / clock skew) vs silence (Daraja
sandbox). Illegal transitions must already be logged, not applied.

## commission-late-payout

- **Alarm:** `devops-g10-commission-late-payout`
- **SLI:** Eligible payouts reach a terminal state by 06:30 EAT;
duplicate disbursement = 0.
- **Owner:** Berissa + Arsema (`services/commission/` CODEOWNERS)
- **First safe action:** Confirm EventBridge
  `devops-g10-commission-daily-close` fired (20:45 UTC / 23:45 EAT) and
  the commission worker `desiredCount >= 1`. Do **not** re-run daily
  close until you have the existing `payout_ledger` row for
  `(agent_id, period)` — replay must be a no-op, never a second B2C.

Then: SQS `devops-g10-commission-close` vs DLQ; Payments
`GET /internal/v1/payouts/:id`. A late run burns the 0.28-run budget;
a duplicate disbursement is an SLO miss with **no** budget.

## dlq-nonempty

- **Alarm:** `devops-g10-sqs-dlq-nonempty`
- **SLI:** Async work that backs the payment/commission journeys.
A stuck DLQ is a hidden SLO miss.
- **Owner:** Arsema (payments callback DLQ) or Berissa+Arsema
  (commission close DLQ)
- **First safe action:** `get-queue-attributes` on both DLQs. **Read,
  do not redrive**, until you know why the message died. Redrive of a
  poison callback can look like a replay — that is the
  [callback replay](game-day.md#2-callback-replay) drill.

Queues:

- `devops-g10-payments-callbacks-dlq` (maxReceiveCount 5)
- `devops-g10-commission-close-dlq` (maxReceiveCount 3)

Capture one message body (no MSISDNs beyond sandbox fakes) under
`evidence/reliability-operations/`.

## sidecar-not-running

- **Alarm:** `devops-g10-sidecar-not-running`
- **SLI:** Observability availability. The ADOT sidecar is
`essential = false`, so ECS will keep serving while traces go dark.
Grafana at G3 has nothing to draw.
- **Owner:** Yordanos (sidecar image/config) · Saloi (signal)
- **First safe action:** Describe a running task and confirm both
  containers `app` and `adot` are `RUNNING`. Do not set the sidecar
  `essential=true` as a "fix" — that would take the app down with the
  collector.

Then: SSM `/devops-g10/adot/config`, sidecar logs
`/devops-g10/adot/<svc>`. Restart the task only after the config is
valid. Every service must still emit JSON logs with `trace_id` /
`span_id` even if the sidecar is down.

## rds-cpu-high

- **Alarm:** `devops-g10-rds-cpu-high`
- **SLI:** Saturation of the shared Postgres instance (`db.t4g.micro`,
[ADR-003](adrs/ADR-003-platform-data-services.md)). CPU is a leading
indicator for POS write p95 and payment callback time.
- **Owner:** Yordanos (instance) · area DRI of the noisy service
- **First safe action:** Identify the noisy query from Performance
  Insights (7-day retention). Do **not** failover (single-AZ, no
  Multi-AZ). Do **not** scale the instance class from the console —
  that is a Terraform change.

Then: kill a runaway session only if it is a known game-day or k6
hold; otherwise reduce k6 / stop a bad release. Slow-query log
threshold is 500ms (`log_min_duration_statement`).

## alb-5xx

- **Alarm:** `devops-g10-alb-5xx`
- **SLI:** Edge availability in front of every service (web / POS /
Payments). Burns the Web and POS 0.1% budgets first.
- **Owner:** Yordanos
- **First safe action:** Split ALB 5xx (`HTTPCode_Target_5XX_Count`
vs `HTTPCode_ELB_5XX_Count`). Target 5xx → the service runbook
(`#pos-5xx` / Payments). ELB 5xx → no healthy targets: check target
group health, ECS `runningCount`, security groups. Do not open the
ALB to the public internet to "debug".

Then: Circuit-breaker rollback if a release emptied the target group.
External synthetic (Route 53 health check on API Gateway `/health`)
should already be alarming — if it is not, the probe is the bug.

---

## Standing recovery targets

Used as the clock for [game-day](game-day.md). These are *recovery*
targets, not SLO targets — burning budget is allowed; missing RTO
without a written reason is not.

| Failure class | RTO | RPO |
|---|---|---|
| Bad ECS release | 10 min (rollback to previous task def) | 0 |
| Cache (Valkey) unreachable | 5 min (restore SG / service) | 0 |
| Commission worker down | 15 min (restore desired count + drain) | 0 duplicate payouts |
| RDS restore (PITR to a **new** instance) | 30 min | ≤ 5 min (PITR) |
| Payment pending / missing callback | 60 s to start reconcile; no fail-on-timeout | 0 extra charges |

RDS PITR window is 7 days. Anything older is out of RPO — say so, do
not pretend a snapshot exists.

## After Yordanos' apply lands

Populate the Slack webhook. Terraform created
`devops-g10/slack-webhook` with `PLACEHOLDER` and
`ignore_changes = [secret_string]`; this command never goes in Git:

```bash
aws secretsmanager put-secret-value \
  --secret-id devops-g10/slack-webhook --region eu-central-1 \
  --secret-string '{"url":"https://hooks.slack.com/services/..."}'
```

Prefer `--secret-string file://webhook.json` and delete the file.
Verify without printing the URL:

```bash
aws secretsmanager get-secret-value \
  --secret-id devops-g10/slack-webhook --region eu-central-1 \
  --query 'SecretString' --output text | jq 'map_values(type)'
```

Then fire the stub alarm once (platform ask #3) and save the Slack
screenshot + Lambda log under `evidence/reliability-operations/`.

## Related

- [alerts.md](alerts.md) — name, SLI, threshold, first action, anchor
- [game-day.md](game-day.md) — how to break it
- [ADR-005](adrs/ADR-005-observability.md) — Grafana workspace
- [platform-asks-g2.md](platform-asks-g2.md) — what Yordanos lands in `services.tf`
- [slo-error-budgets.md](slo-error-budgets.md)
