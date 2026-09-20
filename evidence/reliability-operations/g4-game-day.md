# G4 game day — TillFlow recovery timings

**From:** Saloi (Reliability + operations), for Group 10
**Date:** 2026-09-20 22:04 EAT
**Region:** `eu-central-1` · **Prefix:** `devops-g10`

Public edge only. `MPESA_MODE` stayed **fake**. No `SetAlarmState`.
Did **not** flip Daraja. Did **not** change WAF. RDS PITR ran later the
same evening — see [`g4-restore.json`](g4-restore.json) and
[`docs/g4-evidence.md`](../../docs/g4-evidence.md).

Runner: [`g4/run-game-day.sh`](g4/run-game-day.sh).
Machine record: [`g4-game-day.json`](g4-game-day.json).

## vs runbook table

| Failure class | Runbook RTO | Timed tonight | Met? |
|---|---|---|---|
| Cache (Valkey) unreachable | 5 min (POS fail-open to Postgres; restore SG/service) | **38s** (22:02:14 → 22:02:52 EAT) | yes |
| Commission worker down | 15 min (restore desired count + drain) | **41s** (22:00:09 → 22:00:50 EAT) | yes |
| RDS restore (PITR to a **new** instance) | 30 min | **1664s / 27m44s** (22:37:07 → 23:04:52 EAT). RPO 372s (target 300s) | RTO yes; RPO no — see scar log |
| Payment pending / missing callback | 60 s to start reconcile | G3 Slack ALARM 18:57 → OK 19:07 | yes (G3) |

RPO stayed **0** for cache (ephemeral) and **0 duplicate payouts** for
commission (no close replay, no DLQ redrive).

## 1. Valkey fail-open

Inject: reboot `devops-g10-valkey-001` node `0001`. ElastiCache event
`Cache node 0001 restarted` at **19:02:31 UTC**. Describe still said
`available` before that event — the waiter waits for the restart
event, then `available`.

Not an SG revoke. Terraform owns
`aws_vpc_security_group_ingress_rule.cache_from_ecs`
(`sgr-07f88466a6ed37640`). Cutting that rule would come back as a
**new** rule id and can break the next Release apply. Reboot drops POS
connections the same way; restore is wait-until-available.

| | |
|---|---|
| Sale | `6ced9bb7-23e6-4113-aa66-df1c9d29467f` (public `POST /sales`, tenant `11111111-…`) |
| GET during reboot | **200** four times (0.61–0.65 s), same id — fail-open to Postgres |
| GET after available | **200** then **200** |
| `pos_cache_requests_total` 19:02–19:03 | **error 8** · miss 0 · hit 0 (`OTelLib=tillflow.pos`) |
| POS logs `cache_get_failed` | 5 in the reboot window (`Stream isn't writeable and enableOfflineQueue options is false`) |
| Budget | cache `error` does **not** burn POS (`docs/slo-error-budgets.md`) |

Pay path was not required for this class. Create + GET stayed on the
public Gateway. No `/internal/*`.

## 2. Commission `desiredCount=0`

First safe action (runbook `#commission-fast-burn`): confirm
`desiredCount >= 1`. Do **not** replay daily close.

| | |
|---|---|
| Scale down | 22:00:09 EAT → runningCount 0 at 19:00:23 UTC |
| Restore | desiredCount **1** at 22:00:50 EAT |
| Close replayed | no |
| DLQ redriven | no (visible = 0) |

EventBridge daily close is 01:00 EAT. This window did not collide.
Left live: POS desired 2 / running 2, commission 1 / 1, Valkey
`available`, public `/health` 200.

## 3. RDS PITR

Timed. New instance only. Live left up and protected. Restore deleted
23:08 EAT (`--skip-final-snapshot`). See
[`g4-restore.json`](g4-restore.json).

## Defence one-liners

- Valkey down → POS still serves the sale from Postgres; cache errors do
  not burn the POS budget; node was `available` again in **38s**.
- Commission `desiredCount=0` → restore to 1, do not re-run close; **41s**.
- PITR to a **new** instance in **27m44s** (RTO met). Restore point lagged
  **6m12s** (RPO target 5 min). Then delete the copy; never overwrite live.
