# Naming — TillFlow

All AWS resources the group creates use the prefix `devops-g10-` in
region `eu-central-1` (see
[ADR-001](adrs/ADR-001-region-and-naming.md)). S3 bucket names must be
globally unique, so they additionally carry the 12-digit AWS account ID
as a suffix.

## Examples

| Resource type | Example name |
|---|---|
| ECS cluster | `devops-g10-tillflow` |
| ECS service (POS API) | `devops-g10-tillflow-pos-api` |
| S3 bucket (artifacts) | `devops-g10-tillflow-artifacts-123456789012` |
| IAM role (ECS task role, POS API) | `devops-g10-tillflow-pos-api-task-role` |
| CloudWatch log group | `/devops-g10/tillflow/pos-api` |
| CloudWatch alarm | `devops-g10-tillflow-pos-api-5xx-high` |

## Rules

- Always start with `devops-g10-`.
- After the prefix, use `<app>-<component>[-<qualifier>]`, lowercase,
  hyphen-separated.
- S3 bucket names append `-<aws_account_id>` for global uniqueness.
- Log groups use `/` as the separator to keep the CloudWatch tree
  readable: `/devops-g10/<app>/<component>`.
- Alarms end with the signal being alarmed on (e.g. `-5xx-high`,
  `-cpu-high`, `-queue-age-high`) so their purpose is obvious in
  notifications.
