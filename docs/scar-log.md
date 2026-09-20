# Scar log — TillFlow G4

**Owner:** Saloi  
**When:** 2026-09-20 EAT

What surprised us while executing the runbook. A corrected runbook is
the proof (`docs/runbook.md#rds-pitr`).

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
- **Do not revoke the Terraform cache SG rule**
  (`sgr-07f88466a6ed37640`). A hand-restored rule gets a new id and the
  next Release apply can fail duplicate. Reboot drops connections the
  same way. Berissa’s Monday SG drill must restore *and* leave
  `terraform plan` clean.

## Commission `desiredCount=0`

- Scale 0 → running 0 → 1 took **41s**. No close was on the queue
  (daily close is 01:00 EAT). First safe action is restore count, not
  replay close.

## Runbook fixes applied

- Added `#rds-pitr`: new instance only, copy subnet/SG, record restore
  point, count in-VPC, reconcile order, delete restore only, leave live
  protected.
