# Ownership — TillFlow

One directly responsible engineer (DRI) per primary area. The DRI decides,
implements via their own PRs, links runtime proof in `evidence/`, and
defends the area live at G5. Every member also cross-reviews one other
area's PRs.

GitHub usernames for path ownership live in `CODEOWNERS`. Replace the
placeholder handles there with each person's real account.

| Primary area | DRI | Owns and decides | Cross-reviewer |
|---|---|---|---|
| Product + POS | **Berissa** | Tenant model, frontend flow, POS API, sale state, contracts and validation boundaries | _fill in_ |
| Payments + integrity | **Arsema** | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation and replay | _fill in_ |
| Platform + delivery | **Yordanos** | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline and scans | _fill in_ |
| Reliability + operations | **Saloi** | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and runbook | _fill in_ |

## Minimum personal proof per area

- **Berissa (Product + POS):** ADR + end-to-end sale demo
- **Arsema (Payments + integrity):** Invariant tests + trace
- **Yordanos (Platform + delivery):** Plan + pipeline release
- **Saloi (Reliability + operations):** Dashboard + game day

## Group facts

- Repo: private, group mono-repo — mentor added as collaborator
- AWS region: _fill in once Yordanos's ADR is merged_
- Resource name prefix: `devops-g10-`
- Capstone: TillFlow (POS + M-Pesa on AWS ECS)
- Due: Mon 21 Sep 2026, 23:59 EAT
