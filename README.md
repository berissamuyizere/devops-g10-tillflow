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

## Public demo (G5)

**Base URL (API Gateway, public edge only):**

`https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com`

| Check | Command |
|---|---|
| Health | `curl -sS "$API/health" \| jq .` |
| Ready | `curl -sS "$API/ready" \| jq .` |
| Auth gate | `curl -sS -o /dev/null -w '%{http_code}\n' "$API/sales/00000000-0000-0000-0000-000000000001"` → **401** |

Demo tenant / attendant (seeded on live RDS):

- `TENANT_ID=11111111-1111-1111-1111-111111111111`
- `ATTENDANT_ID=22222222-2222-2222-2222-222222222222`

`MPESA_MODE=fake` on Payments — sandbox MSISDNs only. Success payer: **`254700000000`**.

### Sale → fake pay → paid (one script)

Public path only (`POST /sales` → `POST /sales/:id/pay` → signed `POST /payments/callback` → `GET /sales/:id` shows `paid`):

```bash
aws sso login --profile g10
export AWS_PROFILE=g10 AWS_REGION=eu-central-1

export API_URL=https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=22222222-2222-2222-2222-222222222222
TOKENS=$(aws secretsmanager get-secret-value \
  --secret-id devops-g10/service-tokens \
  --query SecretString --output text)
export DARAJA_CALLBACK_SECRET=$(echo "$TOKENS" | jq -r .daraja_callback_secret)

node services/payments/scripts/g3-trace-payment.js
```

Writes `evidence/payments-integrity/g3-trace-payment.json`. k6 variant:
`evidence/reliability-operations/k6/g3-public-pay.js`.

## Bootstrap / deploy / destroy

G1–G4 stack is live in `eu-central-1`. Quick smoke: `$API_URL/health` (see table above).

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

## Cost (capstone)

At rest, expect **~$45–60/month** before free tier (NAT ~$32, RDS `db.t4g.micro` ~$14, plus Fargate/Valkey/logs). See [`infra/README.md`](infra/README.md) for detail.

Between demos you may set ECS `desired_count = 0` on non-critical services to cut Fargate spend — **do not** `terraform destroy` until after the defence walk-through.

## Cleanup

| When | Action |
|---|---|
| **Now → defence** | Leave the stack up. No deploys after `develop` → `main` promote. No destroy. |
| **Between demos** | Optional: scale ECS services to 0 (platform DRI). RDS and NAT stay. |
| **G5 teardown (last)** | Yordanos only, after Rob says the demo is over: `TF_VAR_rds_deletion_protection=false` → apply → confirm AWS → `terraform destroy` → bootstrap last. See [G5 teardown](#g5-teardown-rds-will-fail-if-you-skip-this) above. |

## Evidence index

| Folder | DRI | Contents |
|---|---|---|
| [`evidence/product-pos/`](evidence/product-pos/) | Berissa | POS seed, commission eligible, Valkey cache, G4 cache break + DLQ |
| [`evidence/payments-integrity/`](evidence/payments-integrity/) | Arsema | Happy path, timeout, B2C close, G3/G4 payment drills |
| [`evidence/platform-delivery/`](evidence/platform-delivery/) | Yordanos | ECS/ECR/smoke, G4 broken release + rollback |
| [`evidence/reliability-operations/`](evidence/reliability-operations/) | Saloi | k6, Slack drill, Grafana Cloud, G4 PITR + game-day |

Gate packs: [`docs/g3-evidence.md`](docs/g3-evidence.md), [`docs/g4-evidence.md`](docs/g4-evidence.md). Saloi owns [`docs/production-readiness.md`](docs/production-readiness.md) (G5).

## Group facts

- **Region:** `eu-central-1`
- **Name prefix:** `devops-g10-`
- **Due:** Mon 21 Sep 2026, 23:59 EAT
- **Rule:** Daraja sandbox only. No real customer data or credentials in Git.
