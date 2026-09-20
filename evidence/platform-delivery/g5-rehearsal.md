# G5 defence — Yordanos (6 minutes)

**Speak this. Do not click Terraform. Do not destroy.**

Public edge: `https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com`  
Proof just taken: [`g5-preflight.json`](g5-preflight.json) · screenshots in [`screenshots/g5/`](screenshots/g5/).

## Clock

| Min | Say |
|---|---|
| 0:00–0:40 | We ship PR → `develop` → `main` → Release. OIDC, no long-lived keys. Smoke is `/health` `/ready` `/version` plus `POST /sales` **401**. Tonight that is all green. |
| 0:40–2:10 | **Failure:** a bad image. We deployed POS `:19` with `/health` 200 and `POST /sales` 500. Circuit breaker did **not** roll back. `release.yml` does not revert. Manual `update-service` to `:18` in **163s** (RTO 10 min, RPO 0). Evidence: [`g4-broken-release.json`](g4-broken-release.json). |
| 2:10–3:20 | Honest: rollback is a **runbook** step (`#bad-ecs-release`), not automatic. Healthy POS **now** is `:20` after later Release — I will not roll back to `:18` on a live demo. |
| 3:20–4:20 | **G5 destroy** dies on RDS until `deletion_protection` is off. Live `devops-g10-pg` is `available` + **protected**. Order: `TF_VAR_rds_deletion_protection=false` → apply → AWS shows `false` → `terraform destroy`. Not before Rob is done. |
| 4:20–5:20 | Berissa’s SG restore minted new ids. I **imported** them. Targeted plan tonight: **No changes**. `cache_from_ecs` `sgr-0f50e811b25ab2ed0`. `alb_from_ecs` `sgr-06deea1208cdcbcb4`. |
| 5:20–6:00 | Grafana at defence is **Cloud** (`punywaxwing1700`), not AMG (SSO assign denied). Fake MPESA stays fake. |

## Answers you will be asked

**Arsema → you: why is rollback not in `release.yml`?**  
ADR-004: no CodeDeploy. Rolling update + circuit breaker only on failed `/health`. A `/ready` or app 500 with a live `/health` stays deployed. Smoke failing does not rewrite the service task def. We roll back by ARN.

**Saloi → you: why does destroy die on RDS?**  
`deletion_protection = true` on `devops-g10-pg`. AWS returns `InvalidParameterCombination`. Flip the variable, apply, then destroy. ALB protection is already false.

**You → Berissa: why fail-open does not burn the POS budget?**  
Cache `result=error` is not a sale-write `outcome=error`. `/health` and `/ready` are excluded. GET `/sales/:id` 200 from Postgres is a successful read.

## Do not say

- That we will live-Daraja tonight.
- That AMG SSO works.
- That #12 was G3/G4.
- That I will destroy before they ask.
