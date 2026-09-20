# G5 defence — Yordanos (6 minutes)

**Speak this. Do not click Terraform. Do not destroy.**

Public edge: `https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com`  
Proof just taken: [`g5-preflight.json`](g5-preflight.json) (01:54 EAT, after
#139 / #140). Scans from the same Release:
[`sbom-web-0671eec4affda3632b40199a1738ca0c8b4a9e69.spdx.json`](sbom-web-0671eec4affda3632b40199a1738ca0c8b4a9e69.spdx.json),
[`trivy-web-0671eec4affda3632b40199a1738ca0c8b4a9e69.txt`](trivy-web-0671eec4affda3632b40199a1738ca0c8b4a9e69.txt)
(`Total: 0 HIGH/CRITICAL`).

Live now: POS `:22` · web `:20` · payments `:24` · commission `:13` · SHA `0671eec`.

Destroy flags ([#141](https://github.com/berissamuyizere/devops-g10-tillflow/pull/141))
are on `develop` only. **Not on `main`. Not applied.** Merge and apply
only immediately before destroy.

## Clock

| Min | Say |
|---|---|
| 0:00–0:40 | We ship PR → `develop` → `main` → Release. OIDC, no long-lived keys. Smoke is `/health` `/ready` `/version` plus `POST /sales` **401**. Tonight that is all green on SHA `0671eec`. |
| 0:40–2:10 | **Failure:** a bad image. We deployed POS `:19` with `/health` 200 and `POST /sales` 500. Circuit breaker did **not** roll back. `release.yml` does not revert. Manual `update-service` to `:18` in **163s** (RTO 10 min, RPO 0). Evidence: [`g4-broken-release.json`](g4-broken-release.json). |
| 2:10–3:20 | Honest: rollback is a **runbook** step (`#bad-ecs-release`), not automatic. Healthy POS **now** is `:22` after later Release — I will not roll back to `:18` on a live demo. |
| 3:20–4:20 | **G5 destroy** dies on RDS until `deletion_protection` is off, and would also die on secrets / S3 / ECR without [#141](https://github.com/berissamuyizere/devops-g10-tillflow/pull/141). Those flags are on `develop`, not applied. Live `devops-g10-pg` is `available` + **protected**. Not before Rob is done. |
| 4:20–5:20 | Berissa’s SG restore minted new ids. I **imported** them. `cache_from_ecs` `sgr-0f50e811b25ab2ed0`. `alb_from_ecs` `sgr-06deea1208cdcbcb4`. |
| 5:20–6:00 | Grafana at defence is **Cloud** (`punywaxwing1700`), not AMG (SSO assign denied). Fake MPESA stays fake. |

## Three honest gaps — who says them

Say these **first**, do not wait to be asked. One owner each so nobody
improvises.

| Gap | Who | The sentence |
|---|---|---|
| Rollback is manual | **Yordanos** | Circuit breaker only drops a task that fails ALB `/health`. A `/ready` or app 500 with `/health` 200 stays deployed until an operator `update-service`. |
| Reconciliation is operator-triggered | **Arsema** | `POST /payments/:id/reconcile` queries Daraja (or the fake adapter). Nothing auto-reconciles. Silence is not a decline (ADR-002). |
| Deployed M-Pesa stays fake | **Arsema** (adapter) / **Saloi** if asked about the standing alarm | Live `MPESA_MODE=fake`. Sandbox STK exists as proof the adapter works. Daraja does not HMAC-sign callbacks, so we do not flip live. `payments-oldest-pending` stays ALARM in fake mode — do not `SetAlarmState`. |

Saloi can open with “three gaps we will not hide” and hand each sentence
to the owner. PITR RPO miss (+72s) and “no Slack for cache” stay in
[`docs/production-readiness.md`](../../docs/production-readiness.md); they
are already written.

## Cross-system practice (Rob asks you about someone else’s area)

Practise on each other. First look, then the trap.

**A payment is stuck `pending`. Where do you look first?**  
Payments row + `providerRef` → CloudWatch `TillFlow` pay/callback traces
→ `payments-oldest-pending` alarm (may already be ALARM) → Slack. Do
**not** re-send STK. First safe action is reconcile (query only). Timeout
payer `254700000003` stays pending on purpose.

**The commission close did not run. What do you check?**  
EventBridge `devops-g10-commission-close` (23:45 EAT) → SQS → ECS
`devops-g10-commission` desired/running → DLQ
`devops-g10-commission-dlq` + that alarm. Replay with
`start-message-move-task`. Duplicate payout = 0 — never re-drive the
same close blindly.

**Budget is burning on POS but the probe is green. What’s happening?**  
Probe hits public `/health` and `/`. Those are **excluded** from every
SLI. A sale-write `outcome=error` burns the POS 99.9% budget. Cache
`result=error` fail-opens to Postgres and does **not** burn it. Look at
`POST /sales` 5xx and Grafana POS burn, not the probe.

**You → Berissa: why fail-open does not burn the POS budget?**  
Cache `result=error` is not a sale-write `outcome=error`. GET `/sales/:id`
200 from Postgres is a successful read.

**Arsema → you: why is rollback not in `release.yml`?**  
ADR-004: no CodeDeploy. Rolling update + circuit breaker only on failed
`/health`. Smoke failing does not rewrite the service task def. We roll
back by ARN.

**Saloi → you: why does destroy die on RDS?**  
`deletion_protection = true` on `devops-g10-pg`. AWS returns
`InvalidParameterCombination`. Flip the variable, apply, then destroy.
ALB protection is already false. Secrets / S3 / ECR need the #141 flags
applied in that same plan.

## Do not say

- That we will live-Daraja tonight.
- That AMG SSO works.
- That #12 was G3/G4.
- That I will destroy before they ask.
- That #141 is already applied.
