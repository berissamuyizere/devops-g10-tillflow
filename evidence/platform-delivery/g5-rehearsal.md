# G5 defence — Yordanos (6 minutes)

**Speak this. The destroy → rebuild already ran.** Do not click Terraform again. Do not destroy again.

Public edge **now:** `https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com`  
Live 200 recapture: [`smoke-summary.json`](smoke-summary.json) (2026-09-24 19:28:45Z).  
Full timeline: [`g5-destroy-rebuild.md`](g5-destroy-rebuild.md).

Files that still say `f9nla14lfh` are **pre-teardown**. That gateway is gone.

## Clock

| Min | Say |
|---|---|
| 0:00–0:40 | We ship PR → `main` → Release. OIDC, no long-lived keys. Smoke is `/health` `/ready` `/version` plus `GET /sales/:id` **401**. Tonight that is green on `mww3x8g0k2`. |
| 0:40–2:00 | **We destroyed.** 2026-09-22 21:48–22:02 UTC. 264 resources. RDS, ECS, old API `f9nla14lfh`, ALB, Valkey, VPC gone. Bootstrap state bucket **kept**. Transcript: [`g5-destroy.log`](g5-destroy.log). |
| 2:00–3:20 | **We rebuilt.** Apply 22:05–22:15 UTC minted `mww3x8g0k2` and a new RDS (protection back **true**). Images + migrate: Release [35832609511](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35832609511). |
| 3:20–4:20 | Two scars. AMG `g-ede3f6a694` is **DELETION_FAILED** — same SSO deny as G3 assign. Grafana at defence is **Cloud**. Commission smoke raced `UNKNOWN`; we poll now (#152) so migrate runs. |
| 4:20–5:20 | Empty RDS after rebuild. Berissa re-seeded Demo Café `11111111-…` / `22222222-…` (exit 0, 16:42Z). Dashboard rewrites now hit the new gateway (#156). |
| 5:20–6:00 | `force_destroy` and secret recovery window 0 exist so a capstone stack can be torn down. We would not ship those defaults in real production. Fake MPESA stays fake. |

## Answers you will be asked

**Why is rollback not in `release.yml`?**  
ADR-004: no CodeDeploy. Circuit breaker only on failed `/health`. Smoke failing does not rewrite the task def. We roll back by ARN (G4: 163s).

**Why did destroy die on Grafana?**  
Cohort SSO **explicit deny** on `sso:DeleteManagedApplicationInstance`. We left the workspace unmanaged (#151). Cloud is the login.

**Why a new Gateway URL?**  
Destroy deleted `f9nla14lfh`. Apply created `mww3x8g0k2`. Same name prefix, new id.

## Do not say

- That we will live-Daraja tonight.
- That AMG SSO works, or that AMG is ACTIVE and assigned.
- That #12 was G3/G4/G5.
- That we will destroy again tonight.
