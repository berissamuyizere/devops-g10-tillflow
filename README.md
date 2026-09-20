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
- **Release** builds `web`, `pos`, `payments`, and `commission` (ARM64 native runner), rolls ECS, then runs DB bootstrap + migrate for POS/Payments.
- **Bootstrap** (state bucket + lock table) is one-time: `infra/bootstrap/`. See [`evidence/platform-delivery/README.md`](evidence/platform-delivery/README.md).
- **Destroy** is G5-only and ordered. Do not `terraform destroy` the shared platform before then.

### G5 teardown (RDS will fail if you skip this)

`infra/rds.tf` sets `deletion_protection = var.rds_deletion_protection` (default **true**) on `devops-g10-pg`. A bare `terraform destroy` returns `InvalidParameterCombination: Cannot delete protected DB instance`. The ALB already has `enable_deletion_protection = false`.

In front of Rob, disable protection **first**, wait until AWS shows it off, then destroy:

```bash
# 1. Flip the flag in the same saved plan path Release uses.
#    Default stays true; only this apply turns it off.
TF_VAR_rds_deletion_protection=false terraform plan -out=plan.bin
terraform apply plan.bin

# 2. Confirm AWS, not just state.
aws rds describe-db-instances \
  --db-instance-identifier devops-g10-pg \
  --region eu-central-1 \
  --query 'DBInstances[0].DeletionProtection'
# -> false

# 3. Then destroy. Final snapshot name is timestamped.
terraform destroy

# 4. Bootstrap last, and only if the state bucket is empty.
# cd infra/bootstrap && terraform destroy
```

CLI equivalent if Terraform is already gone and you only need the instance unlocked:

```bash
aws rds modify-db-instance \
  --db-instance-identifier devops-g10-pg \
  --no-deletion-protection \
  --apply-immediately \
  --region eu-central-1
```

If the destroy is aborted, set `TF_VAR_rds_deletion_protection=true` and apply again. Do not leave protection off overnight.

G2 happy-path JSON: [`evidence/payments-integrity/`](evidence/payments-integrity/). Platform dumps (ECS including the Commission SQS worker, path-routing smoke, tag audit): [`evidence/platform-delivery/`](evidence/platform-delivery/).

## Group facts

- **Region:** `eu-central-1`
- **Name prefix:** `devops-g10-`
- **Due:** Mon 21 Sep 2026, 23:59 EAT
- **Rule:** Daraja sandbox only. No real customer data or credentials in Git.
