# G4 screenshots — who saves what

Paste PNGs in the folder named next to you. JSON dumps already count;
the PNG is the G5 walk-through slide.

## Saloi — `evidence/reliability-operations/screenshots/g4/`

1. `s1-restore-creating.png` — RDS `devops-g10-pg-restore` status Creating
2. `s1-restore-available.png` — same instance Available + restore time (RPO)
3. `s1-row-counts.png` — live vs restore `sales` / `payments` / payout ledger
4. `s1-deleted.png` — instance gone after `--skip-final-snapshot`
5. For **each** of the other three drills: Slack ALARM + Slack RECOVERED
   (`arsema-alarm.png`, `arsema-recovered.png`, same for Berissa / Yordanos)

## Arsema — `evidence/payments-integrity/screenshots/g4/`

1. `uncertain-pending.png` — payment stays `pending`, not `failed`
2. `uncertain-slack.png` — oldest-pending (or equivalent) Slack page
3. `reconcile-one-charge.png` — retry did not double-charge
4. `callback-replay.png` — one legal transition + trace of the duplicate
5. `recovered.png` — Slack RECOVERED

## Berissa — `evidence/product-pos/screenshots/g4/`

1. `cache-break-sg.png` — ECS→Valkey ingress revoked
2. `cache-fail-open.png` — sale still 200 from Postgres; cache `result=error`
3. `cache-restored-plan.png` — `terraform plan` clean after the rule is back
4. `dlq-alarm.png` — `commission-dlq` Slack ALARM
5. `dlq-recovered.png` — move-task done, alarm OK / Slack RECOVERED

## Yordanos — this folder

1. `00-baseline-*` — already saved (POS `:17` 2/2, `/health` `/ready` 200, live PG protected, restore **creating**)
2. `01-smoke-fail.png` — `POST /sales` not 401 after the broken task def
3. `02-slack-alarm.png` — Slack page for `#bad-ecs-release`
4. `03-rollback.png` — `update-service` back to `devops-g10-pos:17`
5. `04-slack-recovered.png` — Slack RECOVERED
6. `05-smoke-ok.png` — `POST /sales` 401 again
7. `06-plan-clean.png` — `terraform plan` no drift after everyone is done
