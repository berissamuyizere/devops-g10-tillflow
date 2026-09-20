# G4 evidence — TillFlow recovery

**From:** Saloi (Reliability + operations), for Group 10
**Date:** 2026-09-20
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

Public edge only. `MPESA_MODE` stayed **fake**. No `SetAlarmState`.
Did **not** overwrite live RDS. Did **not** flip Daraja. Did **not**
merge [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).

Runbook: [`docs/runbook.md`](runbook.md) (`#rds-pitr`, standing table).
Scar log: [`docs/scar-log.md`](scar-log.md).

## Drills

| What broke | Detected | First action | Recovery | RPO / RTO | Met? | Evidence |
|---|---|---|---|---|---|---|
| Valkey unreachable (node reboot) | POS `cache_get_failed` + `pos_cache_requests_total{result=error}=8` | Fail-open GET `/sales/:id` (200); wait for restart event then `available` | **38s** (22:02:14 → 22:02:52 EAT) | RPO 0 / RTO 5 min | yes | [`g4-game-day.json`](../evidence/reliability-operations/g4-game-day.json) |
| Commission worker down (`desiredCount=0`) | ECS `runningCount` 0 | Restore `desiredCount >= 1`. No close replay, no DLQ redrive | **41s** (22:00:09 → 22:00:50 EAT) | 0 duplicate payouts / RTO 15 min | yes | same |
| RDS loss (PITR to **new** instance) | Planned restore (not an alarm) | `restore-db-instance-to-point-in-time` → `devops-g10-pg-restore`. Live left `available` + `deletion_protection` | **1664s / 27m44s** (22:37:07 → 23:04:52 EAT) | RPO **372s** (target 300s) / RTO 30 min | RTO yes; RPO no (backup lag) | [`g4-restore.json`](../evidence/reliability-operations/g4-restore.json) |
| Payment pending / missing callback | G3 Slack ALARM 18:57 → OK 19:07 | Signed callback; do not mark failed | ~10 min to OK | 0 extra charges / start reconcile ≤ 60s | yes (G3) | [`g3-slack-drill.json`](../evidence/reliability-operations/g3-slack-drill.json) |
| Uncertain payment + callback replay (Arsema) | `payments-oldest-pending` was **already in ALARM** since 20:13 EAT, so this payment joined an open alarm rather than tripping a fresh one — see the README | Reconcile (queries Daraja, never re-sends); refuse the retry | **172ms** from reconcile to retry-refused, after a deliberate 90s hold (00:05:08 → 00:06:38 EAT, 21 Sep) | 0 extra charges / 0 duplicate receipts / reconcile started well under 60s | invariants yes; detection partial | [`g4-uncertain-payment.json`](../evidence/payments-integrity/g4-uncertain-payment.json), [`g4-callback-replay.json`](../evidence/payments-integrity/g4-callback-replay.json), [README](../evidence/payments-integrity/g4-README.md) |
| Cache SG revoke (Berissa) | CloudWatch `pos_cache_requests_total{result=error}` **+8**. No Slack (no cache alarm) | Serve Postgres; restore ingress | **113s** (22:32:17 → 22:34:10 EAT) | RPO 0 / RTO 5 min | yes | [`g4-cache-break.json`](../evidence/product-pos/g4-cache-break.json) |
| Commission DLQ (Berissa) | `devops-g10-commission-dlq` ALARM 22:52 → OK 22:56; Slack `eea65e27-…` / `c1a9e8ec-…` | Read DLQ, then `start-message-move-task` | **241s** alarm→OK | 0 duplicate payouts / RTO 15 min | yes | [`g4-dlq-recovery.json`](../evidence/product-pos/g4-dlq-recovery.json) |
| Broken release + ECS rollback (Yordanos) | POST `/sales` **500** (`g4:broken-release`); Slack `#bad-ecs-release`. Circuit breaker did **not** fire (`/health` 200) | Manual `update-service` to `devops-g10-pos:18`. Do not bounce RDS | **163s** (23:30:57 → 23:33:40 EAT) | RPO 0 / RTO 10 min | yes | [`g4-broken-release.json`](../evidence/platform-delivery/g4-broken-release.json) |

## RDS PITR (this evening)

| | |
|---|---|
| Source | `devops-g10-pg` (left up, protected) |
| Target | `devops-g10-pg-restore` (never the live id) |
| Restore point | `2026-09-20T19:30:55Z` (`LatestRestorableTime` at start) |
| Row counts | sales 2430 live / 2429 restore (Δ1 write after the point). Payments 2403 / ledger 11 / callback_log 2412 — exact match |
| Reconcile order | sales → payments → payouts → provider references. Did **not** copy restore onto live |
| Cleanup | deleted restore **23:08 EAT**, `--skip-final-snapshot`, gone 23:09. Live still `available` + protected |

## Sign-off (executed drills)

| Name | Role | Signed |
|---|---|---|
| Saloi | Reliability | 2026-09-20 23:10 EAT |
| Yordanos | Platform | 2026-09-20 23:34 EAT |
| Arsema | Payments | 2026-09-21 00:08 EAT |
| Berissa | Product + POS | |

Arsema’s payment drills are landed. The first run failed on reconcile with a 500 — the fake Daraja adapter held in-flight pushes in per-process memory while Payments runs two tasks — fixed in PR #130 and re-run against `:22`. `payments-oldest-pending` stays in ALARM by design: in fake mode a timeout payment can never be reconciled out of `pending`, so that alarm cannot self-recover. SG rule ids were imported onto the live Terraform state (`cache_from_ecs` `sgr-0f50e811b25ab2ed0`, `alb_from_ecs` `sgr-06deea1208cdcbcb4`) so the next apply does not recreate them.
