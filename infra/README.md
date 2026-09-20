# infra/ — Terraform

TillFlow platform layer. Region `eu-central-1`, prefix `devops-g10-`.
See [ADR-001](../docs/adrs/ADR-001-region-and-naming.md),
[ADR-003](../docs/adrs/ADR-003-platform-data-services.md),
[ADR-004](../docs/adrs/ADR-004-cicd-and-golden-path.md).

## Layout

| Path | Purpose |
|---|---|
| `bootstrap/` | One-time state bucket + DynamoDB lock. Local backend. |
| `versions.tf` `providers.tf` `backend.tf` `variables.tf` | Root plumbing. |
| `data.tf` `locals.tf` | Account/region lookups + shared name/tag helpers. |
| `network.tf` | VPC (2 AZs), public/private/db subnets, NAT, VPC endpoints. |
| `security.tf` | Security groups (ALB, ECS tasks, RDS, cache, endpoints). |
| `alb.tf` `api_gateway.tf` | Internal ALB + HTTP API + VPC Link + WAF. |
| `ecr.tf` | 4 immutable-tag ECR repos with enhanced scanning. |
| `s3.tf` | Artifacts, logs, backups buckets (state lives in `bootstrap/`). |
| `rds.tf` `cache.tf` | Postgres 16 single-AZ, Valkey 7.2. |
| `sqs.tf` `eventbridge.tf` | Async queues + DLQs, daily commission cron. |
| `ecs.tf` `ecs_backend.tf` `ecs_commission.tf` | Cluster + web/pos/payments (ALB) and commission worker (SQS, no ALB). |
| `db_migrate.tf` | One-off DB bootstrap task (schemas/roles). |
| `secrets.tf` | Daraja, Slack, service tokens, per-service DB secrets. |
| `pipeline.tf` | CodeBuild + CodePipeline for `web`. |
| `outputs.tf` | Every consumer-visible value. |

## One-time bootstrap

```bash
cd infra/bootstrap
terraform init
terraform apply
# note the state_bucket + lock_table outputs
```

Then, in the AWS console:

1. **Developer Tools → Settings → Connections** — create a new
   CodeStarConnections connection named `devops-g10-github`, authorize
   the GitHub App on the repo, copy the ARN.

## Apply the platform

Set two GitHub Actions repo variables (Settings → Secrets and variables
→ Variables):

- `AWS_CI_ROLE_ARN` — `arn:aws:iam::<acct>:role/devops-g10-ci-deploy`
- `TF_STATE_BUCKET` — the bucket the bootstrap output printed

Chicken-and-egg: the **first** apply (CI role + platform) happens
locally. After those two variables exist, do not apply from a laptop
again. Merge to `main` runs `.github/workflows/release.yml`:

1. `terraform plan` when `infra/**` changed; the saved `plan.bin` is
   uploaded as an artifact
2. `terraform apply` of **that** file, after a required reviewer
   approves the GitHub Environment `production`
   ([setup](../docs/github-environment-production.md))
3. image build → ECR → ECS rolling update → smoke when `services/{web,pos,payments,commission}`
   change (matrix). After pos/payments: DB bootstrap + `node bin/migrate.js up`.
   Commission has no ALB: smoke is ECS `HEALTHY` + digest, and the image URI must not contain `daraja`.

`workflow_dispatch` on that workflow re-runs the same path.

### G2 — POS + Payments + Commission close worker

After this stack is applied on `main`:

1. Release builds `devops-g10/pos`, `devops-g10/payments`, and `devops-g10/commission`, rolls ECS.
2. POS/Payments smoke is path-routing 401 through API Gateway. Commission smoke is a running `HEALTHY` task (no public ingress).
3. `db-migrate` job runs `devops-g10-db-bootstrap` (schemas/roles), then
   `node bin/migrate.js up` for POS and Payments images.
4. Happy path (Arsema/Berissa): same `api_gateway_url` as both base URLs;
   tokens from `devops-g10/service-tokens`. Daily close is EventBridge → SQS → worker.

CodePipeline is optional. Only pass `codeconnections_arn` if you have
already created the GitHub App connection in the console.

## Smoke test

```bash
API_URL=$(terraform output -raw api_gateway_url)
curl -sSf "$API_URL/health"    # -> {"status":"ok","service":"web"}
curl -sSf "$API_URL/version"   # -> commit + image digest
# Path routing (G2): auth middleware on the right service, not web/ALB.
curl -sS -o /dev/null -w '%{http_code}\n' "$API_URL/sales/00000000-0000-0000-0000-000000000001"
# -> 401
curl -sS -o /dev/null -w '%{http_code}\n' "$API_URL/internal/v1/payments/00000000-0000-0000-0000-000000000001"
# -> 401
```

Refresh live dumps: `./evidence/platform-delivery/collect.sh`.

## Tear-down (G5 only)

`aws_db_instance.pg` has `deletion_protection = var.rds_deletion_protection`
(default `true`). `terraform destroy` fails on `devops-g10-pg` until that
is off. Do **not** start with destroy.

```bash
# 1. Disable protection via the same apply path as Release.
TF_VAR_rds_deletion_protection=false terraform plan -out=plan.bin
terraform apply plan.bin

aws rds describe-db-instances \
  --db-instance-identifier devops-g10-pg \
  --region eu-central-1 \
  --query 'DBInstances[0].DeletionProtection'
# must be false

# 2. Destroy the platform.
terraform destroy

# 3. Bootstrap last, and only if the state bucket is empty.
cd bootstrap && terraform destroy
```

If apply is unavailable, the equivalent unlock is:

```bash
aws rds modify-db-instance \
  --db-instance-identifier devops-g10-pg \
  --no-deletion-protection \
  --apply-immediately \
  --region eu-central-1
```

Re-enable (`TF_VAR_rds_deletion_protection=true` + apply) if the
destroy is aborted. ALB deletion protection is already `false`.

## Cost expectation (capstone)

At rest: ~$45–60/month before free tier. Biggest lines are the NAT
gateway (~$32) and RDS `db.t4g.micro` (~$14). Turn `desired_count = 0`
on the ECS service between demos to save the Fargate cost.
