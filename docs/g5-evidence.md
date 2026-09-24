# G5 evidence — TillFlow destroy → rebuild

**From:** Yordanos (Platform), for Group 10  
**Date:** 2026-09-24  
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

Public edge only. `MPESA_MODE` stayed **fake**. Bootstrap state
bucket was **not** destroyed. Did **not** merge
[#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).
Did **not** Release Daraja live.

**Older evidence that names `f9nla14lfh` was captured before teardown.**
That API no longer exists. Live edge is
`https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com`.

Narrative: [`../evidence/platform-delivery/g5-destroy-rebuild.md`](../evidence/platform-delivery/g5-destroy-rebuild.md).

## Rob's list

| Asked | File | Status |
|---|---|---|
| `terraform destroy` executed and captured | [`g5-destroy.log`](../evidence/platform-delivery/g5-destroy.log) · [`g5-destroy.json`](../evidence/platform-delivery/g5-destroy.json) | done (21:48–22:02Z 22 Sep). 264 destroy. AMG 403 SSO deny |
| Last 200 on the **old** edge | [`g5-destroy-preflight.json`](../evidence/platform-delivery/g5-destroy-preflight.json) · [`.txt`](../evidence/platform-delivery/g5-destroy-preflight.txt) | done 21:22:46Z |
| Rebuild from code captured | [`g5-rebuild.log`](../evidence/platform-delivery/g5-rebuild.log) · [`g5-rebuild-aws.json`](../evidence/platform-delivery/g5-rebuild-aws.json) | done 22:05–22:15Z. New API `mww3x8g0k2`, new RDS |
| Images + migrate | [Release 35832609511](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35832609511) | success 07:50Z 23 Sep |
| Live 200 **after** rebuild | [`smoke-summary.json`](../evidence/platform-delivery/smoke-summary.json) (2026-09-24 19:28:45Z) | `/health` `/ready` 200. `/version` `c394d22`. POS 401. `/internal` 404 |
| Demo tenant on the new RDS | [`g2-seed.json`](../evidence/product-pos/g2-seed.json) | Berissa, 16:42Z 23 Sep, exit 0 |
| Dashboard / Vercel on the new URL | #156 `6e13f0d` | merged |
| Sale → pay → signed callback → paid | [`g5-post-rebuild-e2e.json`](../evidence/product-pos/g5-post-rebuild-e2e.json) | Berissa, 2026-09-24 20:04:17Z on `mww3x8g0k2`. `money_path_passed=true`. 12/12 money checks (sale → pay → signed callback → paid; replay is the same payment; callback replay is a no-op; `paid_at` set once) |
| Probe + alarms + Grafana after rebuild | [`g5-post-rebuild-obs.json`](../evidence/reliability-operations/g5-post-rebuild-obs.json) · [`scar-log.md`](scar-log.md) | Saloi, 23:53 EAT 24 Sep. Probe on `mww3x8g0k2`. 180/180 minutes at 100%. 15 alarms all OK, none `INSUFFICIENT_DATA`. Old edge fails DNS. Grafana CloudWatch `eu-central-1` |

The e2e file also lists two failing checks — "trace found in X-Ray" and "trace covers pos and payments" — because that run set `skip_xray`. That is expected. The G5 gate is `money_path_passed`; G3 already holds the pos↔payments trace.

## What we do not claim

- That AMG is usable. `g-ede3f6a694` is **DELETION_FAILED**. Defence login is Grafana Cloud `punywaxwing1700`.
- That `force_destroy` / `recovery_window_in_days=0` belong in real production. They exist so this capstone stack can be torn down.
- That a full AWS `describe-*` create-time dump was re-run on 24 Sep. SSO was expired; ids and clocks are in the apply transcript.
- Real Daraja. `#144` stays draft.

## Sign-off

| Name | Role | Signed |
|---|---|---|
| Yordanos | Platform | 2026-09-24 22:30 EAT |
| Saloi | Reliability | 2026-09-24 23:53 EAT |
| Arsema | Payments | 2026-09-24 (Daraja/service-tokens re-put; signed callback proven in `g5-post-rebuild-e2e.json`) |
| Berissa | Product + POS | 2026-09-24 23:04 EAT (`g5-post-rebuild-e2e.json` 20:04:17Z) |
