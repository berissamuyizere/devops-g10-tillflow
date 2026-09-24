# G5 destroy → rebuild — Yordanos

**Operator:** yordanoshagos  
**Region:** `eu-central-1` · **Account:** `240462142849`  
**`MPESA_MODE`:** fake the whole time. Bootstrap state bucket **kept**.

Older files that still mention `f9nla14lfh` were captured **before** teardown. They are not the live edge.

## Timeline (UTC)

| When | What | Proof |
|---|---|---|
| 2026-09-22 21:02 | #150 Release applied destroy flags. RDS still protected. | [35784145803](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35784145803) |
| 2026-09-22 21:22:46 | Preflight: old edge `/health` `/ready` **200** | [`g5-destroy-preflight.json`](g5-destroy-preflight.json), [`g5-destroy-preflight.txt`](g5-destroy-preflight.txt) |
| 2026-09-22 21:22–21:48 | Unlock: `TF_VAR_rds_deletion_protection=false` apply. Only RDS protection flipped. | unlock plan was 0 add, 1 change, 0 destroy |
| 2026-09-22 21:48:21 | `terraform apply destroy.bin` started. Plan **264 to destroy**. | [`g5-destroy.log`](g5-destroy.log) |
| 2026-09-22 22:02:52 | Destroy finished. RDS / ECS / APIGW `f9nla14lfh` / ALB / Valkey / VPC gone. AMG `g-ede3f6a694` **DELETION_FAILED** (SSO deny). | same log, last error |
| 2026-09-22 22:05:27 | `terraform apply rebuild.bin` started (`-refresh=false`). **228 to add**. | [`g5-rebuild.log`](g5-rebuild.log) |
| 2026-09-22 22:05:43 | New HTTP API `mww3x8g0k2` created. | [`g5-rebuild-aws.json`](g5-rebuild-aws.json) |
| 2026-09-22 22:15:04 | New RDS `devops-g10-pg` available. Protection **true** again. | same |
| 2026-09-22 22:15:06 | Apply exit 1 only on Grafana service account (workspace DELETION_FAILED). Edge existed; ECR empty → 502/503. | [`g5-rebuild.log`](g5-rebuild.log) |
| 2026-09-22 22:17 | Dispatch Release [35791524104](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35791524104) — plan **failed** refreshing AMG. | GH Actions |
| 2026-09-23 07:01 | #151 merged. Stop managing AMG. Point alarm Grafana URLs at Cloud. | `0287e22` |
| 2026-09-23 07:01–07:06 | Release [35829532373](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35829532373): plan+apply+web/pos/payments green. Commission smoke `UNKNOWN`. Migrate skipped. **First live `/health` 200** on `mww3x8g0k2`. | GH Actions + curl that evening |
| 2026-09-23 07:36–07:50 | #152 merged. Release [35832609511](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35832609511) **success** including commission + **migrate**. | GH Actions |
| 2026-09-23 16:42 | Berissa re-seed Demo Café `11111111-…` / attendant `22222222-…` | [`../product-pos/g2-seed.json`](../product-pos/g2-seed.json) |
| 2026-09-23 19:12 | #155 Release [35907725658](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35907725658) green | GH Actions |
| 2026-09-24 19:17 | #156 on main. Web `/version` commit `c394d22`. | smoke-version.json |
| 2026-09-24 19:28:45 | This pack: live 200 recapture on the **new** gateway | [`smoke-summary.json`](smoke-summary.json) |

## What broke, how we fixed it

| Break | Fix |
|---|---|
| AMG delete 403 `sso:DeleteManagedApplicationInstance` | Left `g-ede3f6a694` DELETION_FAILED. Did not destroy bootstrap. Grafana Cloud stays the login. |
| Refresh of that workspace 404s `DescribeWorkspaceConfiguration` | #151: `removed` block, adopt script no-op, alarm URLs → Cloud |
| Commission smoke `health=UNKNOWN` skipped migrate | #152: poll until HEALTHY |
| Empty RDS after rebuild | #155: Berissa `g5:post-rebuild-seed` |
| Dashboard / Vercel still on `f9nla14lfh` | #156: `LIVE_API` + rewrites → `mww3x8g0k2` |

## Live 200 after rebuild (recapture)

Edge: `https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com`

| Check | Result | When |
|---|---|---|
| GET `/health` | 200 `{"status":"ok","service":"web"}` | 2026-09-24 19:28:45Z |
| GET `/ready` | 200 | same |
| GET `/version` | 200 commit `c394d22` | same |
| GET `/sales/:id` no auth | **401** (POS) | same |
| GET `/internal/v1/payments/:id` | **404** (edge lockdown) | same |

## Honesty

- Full terminal scrollback **was** kept for destroy and rebuild (`g5-destroy.log`, `g5-rebuild.log`).
- AWS CLI SSO was expired while assembling this pack, so `describe-db-instances` create times were **not** re-fetched. Ids and clocks come from the apply transcript.
- G4 imported SG ids died with the old VPC. New SGs exist; do not quote the old `sgr-0f50…` as live.
- `force_destroy` / secret `recovery_window_in_days=0` exist so this capstone stack can be torn down. We would not ship those defaults in a real production account.

## Not this pack

- Berissa: sale → pay → signed callback → `paid` on the new edge (`g5-post-rebuild-e2e.json`).
- Saloi: probe + alarms + Grafana Cloud after rebuild (`scar-log` line).
