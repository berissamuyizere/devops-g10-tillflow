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
| Uncertain payment + callback replay (Arsema) | — | — | not run | — | pending | `evidence/payments-integrity/g4-*.json` |
| Cache SG break + commission DLQ (Berissa) | — | — | not run | — | pending | `evidence/product-pos/g4-*.json` |
| Broken release + ECS rollback (Yordanos) | — | — | not run | — | pending | `evidence/platform-delivery/g4-broken-release.json` |

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
| Yordanos | Platform | |
| Arsema | Payments | |
| Berissa | Product + POS | |

Pending rows wait on Monday’s area drills. Saloi times those; each DRI writes their JSON.
