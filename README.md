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

G1 (web) and G2 (POS + Payments) are live in `eu-central-1`. Public smoke:

`https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com/health`

- **PRs** → `develop`, then `develop` → `main`. Cross-reviewer reviews the area.
- **Apply on `main`** waits on the GitHub Environment `production` (required reviewers) and applies the saved `plan.bin` — it does not re-plan.
- **Release** builds `web`, `pos`, and `payments` (ARM64 native runner), rolls ECS, then runs DB bootstrap + migrate.
- **Bootstrap** (state bucket + lock table) is one-time: `infra/bootstrap/`. See [`evidence/platform-delivery/README.md`](evidence/platform-delivery/README.md).
- **Destroy** is out of band; do not `terraform destroy` the shared platform.

G2 happy-path JSON: [`evidence/payments-integrity/`](evidence/payments-integrity/). Platform dumps (three ECS services, path-routing smoke, tag audit): [`evidence/platform-delivery/`](evidence/platform-delivery/).

## Group facts

- **Region:** `eu-central-1`
- **Name prefix:** `devops-g10-`
- **Due:** Mon 21 Sep 2026, 23:59 EAT
- **Rule:** Daraja sandbox only. No real customer data or credentials in Git.
