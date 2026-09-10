# TillFlow — devops-g10-tillflow

Multi-tenant POS + M-Pesa (Daraja sandbox) on AWS ECS Fargate. One private group mono-repo for Group 10.

## Prerequisites

- GitHub access to this private repo (write for members, at least read for mentors)
- AWS account access in region **`eu-central-1`** (provisioning starts at G1 via Terraform only)
- Docker, and language toolchains as each service lands under `services/`
- Daraja **3.0 sandbox** credentials in AWS Secrets Manager when Payments is built — never commit them
- For local CI later: ability to run unit/integration tests and the deterministic M-Pesa fake adapter (no real money)

## Ownership

| Primary area | DRI | Cross-reviewer |
|---|---|---|
| Product + POS | Berissa | Arsema |
| Payments + integrity | Arsema | Berissa |
| Platform + delivery | Yordanos | Saloi |
| Reliability + operations | Saloi | Yordanos |

Full matrix, decision DRIs, and group facts: [`docs/ownership.md`](docs/ownership.md). Path owners: [`CODEOWNERS`](CODEOWNERS).

## Architecture

Web → API Gateway → VPC Link → ALB → POS / Payments / Commission on ECS Fargate (app + ADOT sidecar), with RDS, Redis/Valkey, S3, SQS+DLQ, and Daraja from Payments only.

See [`docs/architecture.md`](docs/architecture.md) for the diagram, service boundaries, sale→pay→callback, and daily-close→B2C flows.

## Key docs (G0)

| Doc | Purpose |
|---|---|
| [docs/ownership.md](docs/ownership.md) | DRIs, cross-reviewers, group facts |
| [docs/architecture.md](docs/architecture.md) | System diagram and flows |
| [docs/threat-model.md](docs/threat-model.md) | STRIDE + payment abuse cases |
| [docs/slo-error-budgets.md](docs/slo-error-budgets.md) | Draft SLIs / budgets |
| [docs/adrs/ADR-001-region-and-naming.md](docs/adrs/ADR-001-region-and-naming.md) | Region `eu-central-1`, prefix `devops-g10-` |
| [docs/adr-001-tenant-sale-data-model.md](docs/adr-001-tenant-sale-data-model.md) | Tenant / sale model |
| [docs/adrs/ADR-002-idempotency-and-replay-safety.md](docs/adrs/ADR-002-idempotency-and-replay-safety.md) | Idempotency and replay |
| [docs/naming.md](docs/naming.md) | Resource naming examples |

## Repo layout

```
services/web|pos|payments|commission|_shared/
infra/                 # Terraform (G1+)
.github/workflows/     # PR checks + gated apply
docs/                  # ownership, architecture, ADRs, SLOs, threat model
evidence/<area>/       # per-DRI runtime proof
CODEOWNERS
```

## Bootstrap / deploy / destroy

Not available yet — Platform (Yordanos) lands Terraform and one-command bootstrap at **G1**. Until then: clone this repo, read the docs above, and open PRs against `develop` with review from the area cross-reviewer.

## Group facts

- **Region:** `eu-central-1`
- **Name prefix:** `devops-g10-`
- **Due:** Mon 21 Sep 2026, 23:59 EAT
- **Rule:** Daraja sandbox only. No real customer data or credentials in Git.
