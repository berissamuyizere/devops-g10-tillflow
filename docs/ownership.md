# Ownership — TillFlow

One directly responsible engineer (DRI) per primary area. The DRI decides,
implements via their own PRs, links runtime proof in `evidence/`, and
defends the area live at G5. Every member also cross-reviews one other
area's PRs.

| Primary area | DRI | Owns and decides | Cross-reviewer |
|---|---|---|---|
| Product + POS | **Berissa** | Tenant model, frontend flow, POS API, sale state, contracts and validation boundaries | Arsema |
| Payments + integrity | **Arsema** | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation, replay, threat model | Berissa |
| Platform + delivery | **Yordanos** | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline, scans, architecture | Saloi |
| Reliability + operations | **Saloi** | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and runbook | Yordanos |

## Decision artifacts and DRIs

| Artifact | DRI |
|---|---|
| `docs/architecture.md` | Yordanos |
| `docs/threat-model.md` | Arsema |
| `docs/slo-error-budgets.md` | Saloi |
| `docs/runbook.md` / `docs/alerts.md` / `docs/game-day.md` | Saloi |
| Grafana workspace ADR (ADR-005) | Saloi |
| Tenant / sale data model ADR | Berissa |
| Region + naming ADR | Yordanos |
| Idempotency + replay ADR | Arsema |

## Minimum personal proof per area

- **Berissa (Product + POS):** ADR + end-to-end sale demo
- **Arsema (Payments + integrity):** Invariant tests + trace
- **Yordanos (Platform + delivery):** Plan + pipeline release
- **Saloi (Reliability + operations):** Dashboard + game day (`docs/runbook.md`, `docs/alerts.md`, `docs/game-day.md`, ADR-005)

## Group facts

- Repo: https://github.com/berissamuyizere/devops-g10-tillflow (private; mentors as collaborators)
- AWS region: `eu-central-1` (see [ADR-001](adrs/ADR-001-region-and-naming.md))
- Resource name prefix: `devops-g10-`
- Capstone: TillFlow (POS + M-Pesa on AWS ECS)
- Due: Mon 21 Sep 2026, 23:59 EAT
