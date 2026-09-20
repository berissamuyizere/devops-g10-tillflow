# Runbook — TillFlow

**Owner (DRI):** Saloi (Reliability + operations)
**Cross-reviewer:** Yordanos
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

Every CloudWatch alarm in [`docs/alerts.md`](alerts.md) links an anchor
here. Grafana uids: `tillflow-overview`, `tillflow-web`, `tillflow-pos`,
`tillflow-payments`, `tillflow-commission`.

## On-call rotation

Primary answers Slack within 15 minutes during G3–G5. Saloi is always
secondary (reliability DRI). Hand-off is a Slack message naming the next
primary.

| Date (EAT) | Primary | Secondary | Notes |
|---|---|---|---|
| Sun 20 Sep | Saloi | Yordanos | S2–S6 docs + Grafana JSON; Y5 waits on alerts.md |
| Mon 21 Sep | all four | — | G5 defence; no solo changes |

Outside that window: the area DRI in [`ownership.md`](ownership.md) is
primary for their service. Cross-reviewer is secondary.

## Freeze / resume

When the 28-day budget for a surface is **gone**, freeze releases except
fixes. Resume when remaining budget is **> 25% for 24 hours**. See
[`slo-error-budgets.md`](slo-error-budgets.md).

## Slack alert contract

Lambda `devops-g10-slack-notifier` posts **exactly** these fields, on
**ALARM and OK**. Helper:
[`services/_shared/alerts/slack-notify.sh`](../services/_shared/alerts/slack-notify.sh).

| Field | Required | Example |
|---|---|---|
| `environment` | yes | `prod` |
| `service` | yes | `pos` |
| `symptom` | yes | `POS fast burn > 1.44%` |
| `slo_impact` | yes | `POS sale-write SLI; 28d budget 40m19s` |
| `observed` | yes | `error rate 4.1% (p95 820ms)` |
| `grafana_panel` | yes | AMG URL + `d/tillflow-pos?viewPanel=` |
| `runbook` | yes | this file + `#anchor` |
| `owner` | yes | area DRI |
| `first_safe_action` | yes | first safe action below, copied verbatim |

Recovery uses the same contract; Lambda prefixes the title `RECOVERED`.

## How to page

1. Read the Slack fields. Do **not** start with a console click Terraform
   does not own.
2. Jump to the matching `#anchor`.
3. Do the first safe action. If it does not restore, escalate to the area
   DRI and capture timestamps in `evidence/reliability-operations/`.
4. Confirm the OK / recovered Slack post when the alarm clears.

k6 and the demo use the **public API Gateway only** (ADR-005). Never
`/internal/*`. Do not run payment k6 in-VPC.

---

## web-fast-burn

- **Alarm:** `devops-g10-web-fast-burn`
- **SLI:** Eligible web loads succeed at ≥ 99.9%.
- **Owner:** Yordanos
- **First safe action:** Split ALB `HTTPCode_Target_5XX_Count` vs
  `HTTPCode_ELB_5XX_Count` for `devops-g10-web-tg`. Target 5xx → last web
  release. ELB 5xx → healthy-target count. Do not open the ALB to the
  internet.

Then: rollback with `aws ecs update-service --task-definition <previous>`
(ADR-004) if the last digest is the cause.

## web-slow-burn

- **Alarm:** `devops-g10-web-slow-burn`
- **Owner:** Yordanos
- **First safe action:** Same as `#web-fast-burn`, but this is a ticket,
  not a page. Open the ticket, then the split.

## pos-fast-burn

- **Alarm:** `devops-g10-pos-fast-burn`
- **SLI:** Valid sale writes accepted exactly once.
- **Owner:** Berissa
- **First safe action:** `curl` POS `/health` then `/ready` through API
  Gateway. `/health` 200 + `/ready` 503 → dependency (RDS/Valkey), not the
  task. Do not bounce RDS.

Then: logs `/devops-g10/pos` for `unhandled_error`. Confirm 5xx are
`outcome=error`, not excluded `rejected`. Grafana `tillflow-pos`.

## pos-slow-burn

- **Alarm:** `devops-g10-pos-slow-burn`
- **Owner:** Berissa
- **First safe action:** Same as `#pos-fast-burn` (ticket, not page).

## payments-fast-burn

- **Alarm:** `devops-g10-payments-fast-burn`
- **SLI:** Eligible STK/B2C accepted + callback within 60s. ≥ 99.5%.
- **Owner:** Arsema
- **First safe action:** Do **not** mark payments `failed`. Check
  `payments_commands_total{outcome="timeout"}` vs `accepted`. Timeout stays
  `pending` until callback or reconcile
  ([ADR-002](adrs/ADR-002-idempotency-and-replay-safety.md)).

Then: `#payments-oldest-pending`.

## payments-slow-burn

- **Alarm:** `devops-g10-payments-slow-burn`
- **Owner:** Arsema
- **First safe action:** Same as `#payments-fast-burn` (ticket, not page).

## payments-oldest-pending

- **Alarm:** `devops-g10-payments-oldest-pending`
- **Owner:** Arsema
- **First safe action:** Do **not** mark `failed`. List pending payments
  older than 60s and reconcile. Timeout stays `pending`.

Then: `payments.callback_log` for `rejected_bad_signature` vs silence
(Daraja). Grafana `tillflow-payments`.

## commission-fast-burn

- **Alarm:** `devops-g10-commission-fast-burn`
- **SLI:** Close runs succeed; eligible payouts terminal by 06:30 EAT.
- **Owner:** Berissa
- **First safe action:** Confirm commission `desiredCount >= 1` and the
  last `commission_close_runs_total{outcome="error"}` log line. Do **not**
  replay daily close until the `(agent_id, period)` ledger row is in hand.

## commission-slow-burn

- **Alarm:** `devops-g10-commission-slow-burn`
- **Owner:** Berissa
- **First safe action:** Same as `#commission-fast-burn` (ticket, not page).

## commission-dlq

- **Alarm:** `devops-g10-commission-dlq`
- **Owner:** Berissa
- **First safe action:** `get-queue-attributes` on
  `devops-g10-commission-close-dlq`. **Read, do not redrive**, until the
  failure class is known. Redrive of a close message can look like a
  second B2C.

## payments-callbacks-dlq

- **Alarm:** `devops-g10-payments-callbacks-dlq`
- **Owner:** Arsema
- **First safe action:** `get-queue-attributes` on
  `devops-g10-payments-callbacks-dlq`. **Read, do not redrive.** Capture one
  body (sandbox MSISDNs only) under `evidence/reliability-operations/`.

## payout-not-settled

- **Alarm:** `devops-g10-payout-not-settled`
- **SLI:** Eligible payouts terminal by 06:30 EAT; duplicate disbursement
  = 0.
- **Owner:** Berissa + Arsema
- **First safe action:** Confirm EventBridge daily close fired (01:00 EAT
  / 22:00 UTC on current worker schedule — check the live rule, do not
  assume) and `desiredCount >= 1`. Do **not** re-run close until the
  existing `payout_ledger` row for `(agent_id, period)` is in hand.
  Replay must be a no-op.

Then: `payouts_by_status` and SQS vs DLQ. A late run burns the 0.28-run
budget; a duplicate disbursement is an SLO miss with **no** budget.

## probe-down

- **Alarm:** `devops-g10-probe-down`
- **Owner:** Yordanos
- **First safe action:** Check API Gateway + WAF + VPC Link **before**
  blaming ECS. Canary `devops-g10-probe` hits the public Gateway, not the
  internal ALB. Then `#web-fast-burn`.

## ecs-cpu-high

- **Alarm:** `devops-g10-ecs-cpu-high`
- **Owner:** Yordanos
- **First safe action:** Confirm target tracking is 70% CPU. Do not
  change desired count in the console — Terraform owns it. Identify the
  hot service (web / POS / payments / commission) and drop k6 or roll
  back that digest.

## rds-cpu-high

- **Alarm:** `devops-g10-rds-cpu-high`
- **Owner:** Yordanos · noisy-service DRI
- **First safe action:** Performance Insights on `devops-g10-pg`. Do
  **not** failover (single-AZ). Do **not** change instance class in the
  console.

Then: kill a runaway session only if it is known k6/game-day; otherwise
stop the bad release. Slow-query threshold is 500ms.

## bad-ecs-release

- **Alarm:** none automatic. Release smoke (`/health` `/ready` on web;
  `POST /sales` → 401 on POS) is the detector. Circuit breaker only
  rolls back when new tasks fail ALB `/health` — a `/ready` 500 with
  `/health` 200 **stays deployed**. Rollback is a **manual** runbook
  step (ADR-004). `release.yml` does not revert the previous task
  definition on a failed smoke.
- **Owner:** Yordanos
- **RTO / RPO:** 10 min / 0 (no data loss; roll the digest).
- **First safe action:** Confirm `/health` 200 vs `/ready` 5xx through
  API Gateway. Do not bounce RDS. Do not `terraform apply` to "fix"
  an image — the service `ignore_changes`es `task_definition`.

Then:

```bash
# Previous healthy revision — note it BEFORE the bad roll.
aws ecs describe-services --cluster devops-g10 --services devops-g10-pos \
  --region eu-central-1 \
  --query 'services[0].taskDefinition'

aws ecs update-service \
  --cluster devops-g10 \
  --service devops-g10-pos \
  --task-definition devops-g10-pos:<previous> \
  --force-new-deployment \
  --region eu-central-1

aws ecs wait services-stable \
  --cluster devops-g10 --services devops-g10-pos --region eu-central-1
```

Re-run the POS smoke (`POST /sales` → 401, `/ready` 200). Page Slack
`RECOVERED` when it passes. Evidence:
[`evidence/platform-delivery/g4-broken-release.json`](../evidence/platform-delivery/g4-broken-release.json).

---

## Standing recovery targets

These are *recovery* targets, not SLO targets — burning budget is
allowed; missing RTO without a written reason is not.

| Failure class | RTO | RPO |
|---|---|---|
| Bad ECS release | 10 min (rollback to previous task def) | 0 |
| Cache (Valkey) unreachable | 5 min (POS fail-open to Postgres; restore SG/service) | 0 |
| Commission worker down | 15 min (restore desired count + drain) | 0 duplicate payouts |
| RDS restore (PITR to a **new** instance) | 30 min | ≤ 5 min (PITR) |
| Payment pending / missing callback | 60 s to start reconcile; no fail-on-timeout | 0 extra charges |

RDS PITR window is 7 days. Anything older is out of RPO.

## rds-pitr

- **Restore:** `aws rds restore-db-instance-to-point-in-time` to a **new**
  identifier (`devops-g10-pg-restore`). Never overwrite `devops-g10-pg`.
- **Owner:** Saloi
- **First safe action:** Confirm live `devops-g10-pg` is still `available`
  and `deletion_protection = true`. Copy its subnet group and RDS SG.
  Do **not** disable deletion protection on live. Do **not** failover
  (single-AZ).

Then:

1. Record `LatestRestorableTime` on live (that is the restore point /
   actual RPO) and the wall-clock start.
2. Restore with `--use-latest-restorable-time`, same
   `--db-subnet-group-name` and `--vpc-security-group-ids` as live,
   `--db-instance-class db.t4g.micro`, `--no-publicly-accessible`.
3. Wait until the **new** instance is `available`. That elapsed time is
   RTO. Target 30 min. RPO target ≤ 5 min (`now − LatestRestorableTime`).
4. Compare row counts (in-VPC, same app users): `pos.sales`,
   `payments.payments`, `payments.payout_ledger`. Deltas are writes
   after the restore point, not corruption.
5. Reconcile **before** declaring recovery, in this order: sales →
   payments → payouts → provider references (checkout / receipt ids).
   Do not rewrite live from the restore copy.
6. Delete the restore instance: disable `deletion_protection` on
   **restore only**, then
   `delete-db-instance --skip-final-snapshot`. Leave live protected.

Live has `deletion_protection = true`, so `terraform destroy` also
fails on RDS until that flag is cleared (G5). PITR is the recover
path, not destroy.

## Slack webhook

Terraform created `devops-g10/slack-webhook` with `PLACEHOLDER` and
`ignore_changes = [secret_string]`. Populate out of band — **never
commit the URL**:

```bash
aws secretsmanager put-secret-value \
  --secret-id devops-g10/slack-webhook --region eu-central-1 \
  --secret-string file://webhook.json
```

`webhook.json` shape: `{"url":"https://hooks.slack.com/services/…"}`.
Delete the file after. Verify without printing the URL:

```bash
aws secretsmanager get-secret-value \
  --secret-id devops-g10/slack-webhook --region eu-central-1 \
  --query 'SecretString' --output text | jq 'map_values(type)'
```

Expect `{"url":"string"}`. If the Lambda log says `slack webhook not
populated in Secrets Manager`, this secret is still `PLACEHOLDER`.

## Related

- [alerts.md](alerts.md)
- [slo-error-budgets.md](slo-error-budgets.md)
- [ADR-005](adrs/ADR-005-observability.md)
