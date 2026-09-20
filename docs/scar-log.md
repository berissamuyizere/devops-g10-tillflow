# Scar log — TillFlow G4

**Owner:** Saloi  
**When:** 2026-09-20 → 2026-09-21 EAT

What surprised us while executing the runbook. A corrected runbook is
the proof (`docs/runbook.md#rds-pitr`, `#bad-ecs-release`,
`#commission-dlq`). G5 verdict: [`docs/production-readiness.md`](production-readiness.md).

## RDS PITR

- **`LatestRestorableTime` lagged 6m12s.** Start 22:37:07 EAT, restore
  point 19:30:55 UTC. Runbook RPO is 5 min. We used
  `--use-latest-restorable-time` immediately as the brief says. Waiting
  for a closer point would have delayed the RTO clock, not reduced AWS’s
  apply lag on `db.t4g.micro`. Missed RPO by 72s; RTO (27m44s) still met.
- **Most of the 27 minutes was `backing-up`, not restore apply.** Status
  went creating → configuring-enhanced-monitoring (~10 min) → backing-up
  (~15 min) → modifying → available. Do not call it failed because the
  endpoint is still null at minute 10.
- **The new instance did not copy `deletion_protection`.** Live is
  `true`; restore came up `false`, so we deleted with
  `--skip-final-snapshot` without a modify. G5 `terraform destroy` still
  fails on **live** until that flag is cleared — Yordanos, not this drill.
- **POS was +1 sale vs restore; payments matched exactly.** The extra
  sale/line is a write after the restore point (expected), not data loss.
  Reconcile order stays sales → payments → payouts → provider refs. We
  did not replay restore onto live.
- **This drill has no Slack.** It is an operator restore. Do not
  `SetAlarmState` to invent one. Detection is the runbook step.

## Valkey fail-open (earlier tonight)

- **`describe-replication-groups` stayed `available` before the node
  actually restarted.** First waiter exited in 9s and missed
  `cache_get_failed`. Second run waited for the ElastiCache “Cache node
  0001 restarted” event, then `available` (38s, 8 cache errors).
- **Do not revoke the Terraform cache SG rule and walk away.**
  Original id was `sgr-07f88466a6ed37640`. Berissa’s Monday revoke
  came back as `sgr-0f50e811b25ab2ed0`. That id is now **imported**
  on live state (`cache_from_ecs`). Reboot still drops connections
  the same way if you only need fail-open proof.

## Commission `desiredCount=0`

- Scale 0 → running 0 → 1 took **41s**. No close was on the queue
  (daily close is 01:00 EAT). First safe action is restore count, not
  replay close.

## Cache SG revoke (Berissa)

- Sale stayed **200** for 113s with Valkey cut. `pos_cache_requests_total{result=error}`
  **+8**. No Slack — there is no cache alarm. Detection is the EMF
  counter (about 60s lag). Fail-open does **not** burn the POS
  sale-write budget.
- Restored rule is a **new** id. Import it; do not let the next
  Release recreate a duplicate.

## Commission DLQ (Berissa)

- Poller `VisibilityTimeout=300`, so three receives take **~15 min**
  even when the queue’s own maxReceiveCount is 3. Do not call the
  drill stuck at minute 5.
- ALB hairpin revoke (`sgr-0fe7f2b57d9676326`) is what made the
  poison fail (`fetch failed` to POS `/internal`). Restore came back
  as `sgr-06deea1208cdcbcb4` and is imported (`alb_from_ecs`).
- First safe action is **read**, then `start-message-move-task`.
  ALARM 22:52 → OK 22:56, Slack yes. 0 duplicate payouts (period
  `2099-01-01`, zero eligible).

## Uncertain payment (Arsema)

- First live reconcile **500**. Fake Daraja kept in-flight pushes in
  a per-process `Map`; Payments runs **two** tasks, so the other
  task could not `stkQuery`. Fixed in [#130](https://github.com/berissamuyizere/devops-g10-tillflow/pull/130)
  (`stkQuery` rebuilds the entry from request fields). Re-run on `:22`.
- `payments-oldest-pending` was **already ALARM** since 20:13 EAT.
  Fake timeout rows can never leave `pending` (query 1100 forever).
  The alarm cannot self-recover in fake mode. Do not `SetAlarmState`
  to invent an OK.

## Broken release (Yordanos)

- Circuit breaker does **not** save a `/ready` 500 when `/health`
  stays 200. Rollback is **manual** (`:19` → `:18`, 163s).
  `release.yml` does not revert the previous task definition.
  Added `#bad-ecs-release`.

## Runbook fixes applied

- Added `#rds-pitr`: new instance only, copy subnet/SG, record restore
  point, count in-VPC, reconcile order, delete restore only, leave live
  protected.
- Added `#bad-ecs-release`: smoke is the detector; circuit breaker
  only watches `/health`; rollback is `update-service` to the previous
  revision.
