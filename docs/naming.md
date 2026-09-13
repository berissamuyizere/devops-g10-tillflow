# Naming — TillFlow

All AWS resources the group creates use the prefix `devops-g10-` in
region `eu-central-1` (see
[ADR-001](adrs/ADR-001-region-and-naming.md)). There is **no** extra
`tillflow` name segment — the product name lives in tags
(`capstone=tillflow`), not in resource names. S3 bucket names must be
globally unique, so they additionally carry the 12-digit AWS account ID
as a suffix.

Terraform's `name_prefix` variable is `devops-g10` (no trailing hyphen).
Every resource interpolates `"${var.name_prefix}-…"` or
`"${var.name_prefix}/…"`.

## Examples (matches live infra)

| Resource type | Example name |
|---|---|
| ECS cluster | `devops-g10` |
| ECS service (web) | `devops-g10-web` |
| ECS service (POS, G2) | `devops-g10-pos` |
| S3 bucket (artifacts) | `devops-g10-artifacts-<account_id>` |
| IAM role (CI deploy) | `devops-g10-ci-deploy` |
| IAM role (ECS task, POS) | `devops-g10-pos-task` |
| CloudWatch log group | `/devops-g10/web` |
| SSM parameter | `/devops-g10/adot/config` |
| Secret | `devops-g10/daraja` |
| CloudWatch alarm | `devops-g10-web-5xx-high` |

## Rules

- Always start with `devops-g10-` (or `/devops-g10/` for log groups and
  SSM parameters, or `devops-g10/` for ECR repos and secrets).
- After the prefix, use `<component>[-<qualifier>]`, lowercase,
  hyphen-separated. Do not insert `tillflow` in the name.
- S3 bucket names append `-<aws_account_id>` for global uniqueness.
- Log groups use `/` as the separator: `/devops-g10/<component>`.
- Alarms end with the signal being alarmed on (e.g. `-5xx-high`,
  `-cpu-high`, `-queue-age-high`) so their purpose is obvious in
  notifications.
- Required tags on every resource: `group`, `owner`, `environment`,
  `service`, `managed-by=terraform`, `capstone=tillflow`.
