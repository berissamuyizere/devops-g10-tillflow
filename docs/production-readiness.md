# Production readiness — TillFlow

**From:** Saloi (Reliability + operations), for Group 10
**Date:** 2026-09-21
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`
**Verdict:** **GO for the G5 walk-through.** Not a claim of 24/7
production forever.

Public edge only. `MPESA_MODE` is **fake** on purpose. Did **not**
merge [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).
Did **not** flip Daraja. Did **not** overwrite live RDS. Do **not**
`terraform destroy` until they say the demo is over.

## Gates

| Gate | Status | Pointer |
|---|---|---|
| Golden path | PR → `develop` → `main` → Release (`plan.bin` behind `production`) → public smoke. No `latest`. | [ADR-004](adrs/ADR-004-cicd-and-golden-path.md) |
| SLOs + freeze | Web/POS 99.9%, payments 99.5%, commission 99.0%. Budget gone → freeze except fixes. Resume when remaining **> 25% for 24h**. | [slo-error-budgets.md](slo-error-budgets.md) |
| Grafana | **Cloud** `punywaxwing1700`, not AMG. CloudWatch `eu-central-1`. Five `tillflow-*` dashboards. | [g3-evidence.md](g3-evidence.md) |
| k6 | Public Gateway only. 22 min envelope, **2 paid-sale flows/s × 15 min** soak. Checks 99.97%, p95 **253 ms**, failures **0.01%**. WAF **200** again. | [k6-analysis.md](../evidence/reliability-operations/k6-analysis.md) |
| Slack ALARM + OK | Real pending STK, not `SetAlarmState`. 18:57 → 19:07 EAT. | [g3-slack-drill.json](../evidence/reliability-operations/g3-slack-drill.json) |
| Game day | All five failure classes timed. G4 signed by all four. RPO miss on PITR is written. | [g4-evidence.md](g4-evidence.md), [scar-log.md](scar-log.md) |
| Destroy order | Live RDS `deletion_protection=true`. Destroy fails until that flag is off. | README G5 teardown; `var.rds_deletion_protection` |
| Residuals | Listed below. Honest over tidy. | this file |

## Live surface

| Item | Value |
|---|---|
| Public edge | `https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com` |
| Probe | `devops-g10-probe` every minute on public `/health` and `/` |
| Pay | `POST /sales/:id/pay` on the Gateway. Never `/internal/*`. |
| Demo payer | `254700000000` (fake STK + signed callback → sale `paid`) |
| Timeout payer | `254700000003` (stays `pending`; silence is not a decline) |
| POS after rollback | `devops-g10-pos:18` (broken `:19` is not running) |
| CPU tracking | POS + Payments **70%**, min 2 / max 4 |
| WAF | **200** req / 5 min / IP. Callback path exempt. |
| RDS | `devops-g10-pg`, single-AZ `db.t4g.micro`, 7-day PITR, **protected** |
| Cache | Valkey `devops-g10-valkey`. POS `GET /sales/:id` fail-opens to Postgres. |
| Grafana (defence) | https://punywaxwing1700.grafana.net — Admin Saloi `akezasaloi@gmail.com`. AMG `g-ede3f6a694` exists; SSO assign denied. Do **not** open AMG. |

Imported SG ids (Berissa’s restore, so the next apply does not
recreate them): `cache_from_ecs` `sgr-0f50e811b25ab2ed0`,
`alb_from_ecs` `sgr-06deea1208cdcbcb4`.

## SLOs and freeze

Copied so the walk-through does not need a second file:

| Surface | Target | 28-day budget | Fast burn (page) | Slow burn (ticket) |
|---|---|---|---|---|
| Web | 99.9% / p95 < 500 ms | 40m19s | > 1.44% | > 0.6% |
| POS sale-write | 99.9% / p95 < 400 ms | 40m19s | > 1.44% | > 0.6% |
| Payments | 99.5% accepted + callback ≤ 60s | 3h21m36s | > 7.2% | > 3% |
| Commission | 99.0% terminal by 06:30 EAT; **duplicate = 0** | 0.28 late runs | > 14.4% | > 6% |

`/health` and `/ready` are excluded from every SLI. Cache
`pos_cache_requests_total{result=error}` fail-opens and **does not**
burn the POS sale-write budget — Postgres still accepted the GET.
A valid sale write that 5xxs because a dependency is down **does**
burn it. Duplicate disbursement has **no** budget.

Overview panels 11–14 show budget remaining:
`1 − (errors ÷ (eligible × (1 − SLO target)))`. Freeze at 0.

## Observability

ADR-005 fallback is what we open: **Grafana Cloud**, CloudWatch
`eu-central-1`, uids `tillflow-overview`, `tillflow-web`,
`tillflow-pos`, `tillflow-payments`, `tillflow-commission`.

Namespace `TillFlow` (ADOT EMF). **No IDs in labels.** Slack path:
CloudWatch → SNS `devops-g10-alerts` → Lambda
`devops-g10-slack-notifier` → secret `devops-g10/slack-webhook`.
Posts **ALARM and OK**. Webhook is never in Git.

## Recovery vs runbook

Full rows and evidence: [`g4-evidence.md`](g4-evidence.md).

| Failure class | Timed | Target | Met? |
|---|---|---|---|
| Valkey reboot (fail-open) | **38s** | RTO 5 min / RPO 0 | yes |
| Cache SG revoke | **113s**, +8 cache errors, GET 200, no Slack | RTO 5 min / RPO 0 | yes |
| Commission `desiredCount=0` | **41s**, no close replay | RTO 15 min / 0 duplicate payouts | yes |
| Commission DLQ | ALARM **22:52** → move-task → OK **22:56** (**241s**), Slack yes | RTO 15 min / 0 duplicate payouts | yes |
| Uncertain pay + replay | Pending never failed. Replay = one legal transition, one receipt. Retry **409** | 0 extra charges | invariants yes; detection partial (alarm already firing) |
| Broken POS release | Manual `:19` → `:18` in **163s**. Circuit breaker did **not** fire (`/health` 200) | RTO 10 min / RPO 0 | yes |
| RDS PITR (new instance) | **27m44s** available. Restore point lagged **6m12s** | RTO 30 min / RPO ≤ 5 min | **RTO yes; RPO no** (72s over) |

PITR: new id `devops-g10-pg-restore` only. Live left `available` +
protected. Reconcile order: sales → payments → payouts → provider
refs. Did not copy restore onto live. Restore deleted 23:08 EAT.

## Honest residuals

These stay true at defence. Do not paper them.

1. **PITR RPO missed by 72s.** `LatestRestorableTime` on `db.t4g.micro`
   lagged 6m12s. We used `--use-latest-restorable-time` immediately.
   Waiting would have delayed RTO, not closed AWS’s apply lag.
2. **`payments-oldest-pending` cannot self-recover in fake mode.**
   Timeout payer `stkQuery` answers 1100 forever. ADR-002: silence is
   not a decline, so those rows stay `pending` and the age climbs.
   Arsema’s drill joined an alarm already firing since 20:13 EAT.
   Runbook `#payments-oldest-pending`: fake mode stays ALARM; do **not**
   `SetAlarmState`; recovery is an operator resolve.
3. **Rollback is not in `release.yml`.** Smoke can fail and the bad
   task definition stays. Circuit breaker only drops tasks that fail
   ALB `/health`. A `/ready` 500 with `/health` 200 stays deployed
   until an operator runs `update-service` (ADR-004).
4. **No Slack for cache errors.** Detection is the EMF counter, not
   an alarm. That is why Berissa’s SG drill has no Slack and the
   reboot drill used POS logs + CloudWatch.
5. **AMG human login is blocked.** Workspace exists; this role cannot
   assign SSO users. Cloud is the defence login.
6. **Standing cost is more than app compute.** k6 soak did not add
   tasks. App Fargate now is **~$0.16 / hour** (7 × 0.5 vCPU / 1 GB
   ARM in `eu-central-1`). RDS, Valkey, NAT, ALB, API Gateway sit
   under that. Leaving WAF at 2000 would not change compute; it
   widens abuse — that is why it is 200.

## Cost (app compute)

From the 22 min k6 envelope
([k6-analysis.md](../evidence/reliability-operations/k6-analysis.md)):

| | USD / hour |
|---|---|
| 7 tasks × 0.5 vCPU × $0.03725 | 0.130 |
| 7 tasks × 1 GB × $0.00409 | 0.029 |
| **App compute now** | **~0.16** |
| Extra if POS+Payments 2→4 | +~0.09 |

Soak incremental Fargate was ~$0. Do not leave WAF at 2000.

## Teardown (Yordanos only, after they say the demo is over)

Live `devops-g10-pg` has `deletion_protection = true`
(`var.rds_deletion_protection` defaults **true**). A bare
`terraform destroy` returns `InvalidParameterCombination`. That is
the scar from PITR: the **restore** copy came up unprotected; **live**
did not.

```bash
# 1. Same saved-plan path Release uses. Default stays true.
TF_VAR_rds_deletion_protection=false terraform plan -out=plan.bin
terraform apply plan.bin

# 2. Confirm AWS, not just state.
aws rds describe-db-instances \
  --db-instance-identifier devops-g10-pg \
  --region eu-central-1 \
  --query 'DBInstances[0].DeletionProtection'
# -> false

# 3. Then destroy. Bootstrap last, only if the state bucket is empty.
terraform destroy
# cd infra/bootstrap && terraform destroy
```

If the destroy is aborted, apply again with the variable **true**.
Do not leave protection off overnight. Nobody else touches AWS.

## What we are not claiming

- Real Daraja / live money. Fake adapter, sandbox MSISDNs only.
- Amazon Managed Grafana as the defence login.
- Automatic ECS rollback in GitHub Actions.
- PITR RPO ≤ 5 min on `db.t4g.micro` (we missed it; see scar log).
- Multi-AZ RDS or a Valkey replica.
- Merging [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).

## Related

- [runbook.md](runbook.md) — first safe action per alarm
- [scar-log.md](scar-log.md) — what the drills taught us
- [g4-evidence.md](g4-evidence.md) — timed rows, all four signed
- [g3-evidence.md](g3-evidence.md) — Grafana, k6, Slack
- [alerts.md](alerts.md) — CloudWatch names
- [ownership.md](ownership.md) — DRIs

## Sign-off

G4 drills are already signed on [`g4-evidence.md`](g4-evidence.md)
(Saloi 23:10, Yordanos 23:34, Berissa 23:55, Arsema 00:08). This
table is the G5 verdict.

| Name | Role | Signed |
|---|---|---|
| Saloi | Reliability | 2026-09-21 00:25 EAT |
| Yordanos | Platform | |
| Arsema | Payments | |
| Berissa | Product + POS | |
