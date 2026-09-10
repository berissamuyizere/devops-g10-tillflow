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
| `secrets.tf` | Daraja + Slack placeholders (values set out-of-band). |
| `iam.tf` | GitHub OIDC + `devops-g10-ci-deploy`, per-service task/exec roles. |
| `ecs.tf` | Cluster + `web` Fargate service with app + ADOT sidecar. |
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

- `AWS_CI_ROLE_ARN` — will be `arn:aws:iam::<acct>:role/devops-g10-ci-deploy`
  after the first apply. Chicken-and-egg: the first apply happens locally.
- `TF_STATE_BUCKET` — the bucket the bootstrap output printed.

Local first-apply (once):

```bash
cd infra
terraform init \
  -backend-config="bucket=devops-g10-tfstate-<acct>" \
  -backend-config="dynamodb_table=devops-g10-tflock" \
  -backend-config="region=eu-central-1" \
  -backend-config="key=platform/terraform.tfstate"

terraform apply \
  -var="codeconnections_arn=arn:aws:codeconnections:eu-central-1:<acct>:connection/<uuid>"
```

After that, subsequent applies happen via
`.github/workflows/terraform-apply.yml` on pushes to `main`.

## Smoke test

```bash
API_URL=$(terraform output -raw api_gateway_url)
curl -sSf "$API_URL/health"    # -> {"status":"ok","service":"web"}
curl -sSf "$API_URL/version"   # -> commit + image digest
```

## Tear-down

```bash
terraform destroy
# then, if you really mean it:
cd bootstrap && terraform destroy   # will fail unless state bucket is emptied
```

## Cost expectation (capstone)

At rest: ~$45–60/month before free tier. Biggest lines are the NAT
gateway (~$32) and RDS `db.t4g.micro` (~$14). Turn `desired_count = 0`
on the ECS service between demos to save the Fargate cost.
