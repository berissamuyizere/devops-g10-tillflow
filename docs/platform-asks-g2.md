# G2 platform asks — Reliability → Yordanos

**From:** Saloi (Reliability + operations)
**To:** Yordanos (Platform + delivery)
**Land in:** G2 `infra/services.tf` (and small companions:
`infra/grafana.tf`, `infra/alerts.tf` — your call on file split)
**When:** G2 window 13–15 Sep 2026, after the G1 apply
**Why:** G3 cannot draw panels, page Slack, or run an external probe
until these exist. None of this is a console click.

These are **asks**, not a PR against `infra/`. You implement; Saloi
reviews the reliability surface (alarm names, SNS, Lambda contract,
Grafana auth) on that PR.

Region `eu-central-1`, prefix `devops-g10-`, required tags from
[ADR-001](adrs/ADR-001-region-and-naming.md). Alarm names must match
[`docs/alerts.md`](alerts.md) exactly so the runbook anchors stay
stable.

---

## 1. Route 53 health check → CloudWatch alarm on `/health`

External synthetic. Hits **API Gateway**, not the internal ALB,
because the G5 demo and users arrive via the public URL.

- `aws_route53_health_check.external_health`
  - FQDN = host of `terraform output -raw api_gateway_url`
  - Path `/health`
  - Protocol `HTTPS`, port 443
  - `request_interval = 30`
  - `failure_threshold = 2`
  - Regions: at least two (leave AWS defaults)
  - Search string optional: `"ok"`
- `aws_cloudwatch_metric_alarm.external_health`
  - Name: `devops-g10-external-health`
  - Namespace `AWS/Route53`, metric `HealthCheckStatus`
  - Statistic `Minimum`, period 60, evaluation 1
  - Threshold `< 1` (unhealthy)
  - Alarm / OK actions: the SNS topic in ask #3
  - Alarm description must include
    `https://github.com/berissamuyizere/devops-g10-tillflow/blob/main/docs/runbook.md#alb-5xx`

`/health` is excluded from SLI numerators (ADR-004). This alarm is
reachability, not the POS/Payments success SLI.

---

## 2. Amazon Managed Grafana workspace + service-account token

Decision: [ADR-005](adrs/ADR-005-observability.md).

- `aws_grafana_workspace.main`
  - Name: `devops-g10-grafana`
  - `grafana_version` current GA (10.x if offered)
  - Auth: IAM Identity Center **if already enabled on the account**,
    else `AWS_IAM`
  - Permission type `SERVICE_MANAGED`
  - Account access `CURRENT_ACCOUNT`
  - Datasources: `CLOUDWATCH`, `XRAY`
  - Role: a workspace IAM role that can `cloudwatch:Get*`,
    `logs:StartQuery`, `logs:GetQueryResults`, `xray:Get*`,
    `xray:BatchGetTraces` in this account / region only
- Assign the four DRIs as Editors (IAM users or IdC users)
- `aws_secretsmanager_secret.grafana_sa`
  - Name: `devops-g10/grafana/sa-token`
  - Placeholder version `{"token":"PLACEHOLDER"}`
  - `lifecycle { ignore_changes = [secret_string] }` — same pattern
    as `infra/secrets.tf` slack/daraja
- Output `grafana_workspace_endpoint` so G3 dashboards have a URL

Saloi will create the Grafana service account **inside** the
workspace after apply (AMG cannot mint that token in Terraform
cleanly) and `put-secret-value` once, like the Slack webhook.

---

## 3. Stub alarm → SNS → Lambda → `slack-notify.sh`

Exercise the [alert contract](runbook.md#slack-alert-contract)
**before** any real threshold fires.

```
CloudWatch alarm (devops-g10-alert-path-stub)
        │
        ▼
 SNS topic devops-g10-alerts
        │
        ▼
 Lambda  devops-g10-slack-notify
        │  GetSecretValue devops-g10/slack-webhook
        ▼
 Slack incoming webhook, contract fields only
```

### SNS

- Topic name: `devops-g10-alerts`
- No email subscription. Slack is the only subscriber, via Lambda.
- KMS: AWS-managed is fine for the capstone (same posture as RDS).

### Lambda

- Name: `devops-g10-slack-notify`
- Runtime: whatever you already operate (Python 3.12 is fine). It
  does **not** have to exec the shell helper, but it **must** POST
  the same JSON fields. Reference implementation:
  [`services/_shared/alerts/slack-notify.sh`](../services/_shared/alerts/slack-notify.sh).
- Env: `ENVIRONMENT=prod`, `SECRET_ID=devops-g10/slack-webhook`
- Timeout 10s, memory 128 MB, no VPC (webhook is public; secrets
  via the AWS API).
- Permission: `secretsmanager:GetSecretValue` on that secret only;
  `sns:Subscribe` is on the SNS side.

### Contract the Lambda must emit

CloudWatch → SNS → Lambda event is noisy. Map it:

| Slack field | Source |
|---|---|
| `environment` | Lambda env `ENVIRONMENT` |
| `service` | Alarm tag `service`, else `platform` |
| `symptom` | `AlarmName` + `NewStateValue` |
| `slo_impact` | Alarm description first line, or `n/a (stub)` |
| `observed` | `NewStateReason` |
| `grafana_panel` | `https://<grafana_endpoint>/d/tillflow/slo` (placeholder until G3) |
| `runbook` | URL from alarm description, else `docs/runbook.md` |
| `owner` | Alarm tag `owner`, else `saloi` |
| `first_action` | Alarm tag `first_action`, else `see runbook` |

Tone: `danger` on ALARM, `info` on OK, `warning` if you wire
INSUFFICIENT_DATA.

### Stub alarm

- Name: `devops-g10-alert-path-stub`
- Metric: a custom metric `TillFlow/AlertPathStub` that a one-line
  `aws cloudwatch put-metric-data` can trip. Do **not** use a real
  service metric — we need to fire this on command without breaking
  prod.
- Description includes the runbook URL.
- Tags: `service=reliability`, `owner=saloi`,
  `first_action=confirm Slack received the contract fields`

**G2 proof:** after Saloi populates the webhook secret,

```bash
aws cloudwatch put-metric-data --region eu-central-1 \
  --namespace TillFlow --metric-name AlertPathStub --value 1
```

Slack shows one `danger` message with every contract field, then an
`info` recovery when the metric returns to 0. Screenshot →
`evidence/reliability-operations/`.

---

## 4. Wire the minimum alarm set

Once metrics exist, the same SNS topic receives:

| CloudWatch alarm name | Metric (see [alerts.md](alerts.md)) |
|---|---|
| `devops-g10-pos-5xx` | POS TG 5xx (web TG until POS is on the ALB) |
| `devops-g10-payments-callback-lag` | EMF or log-metric fallback |
| `devops-g10-commission-late-payout` | EventBridge miss and/or EMF |
| `devops-g10-sqs-dlq-nonempty` | both DLQs, `>= 1` |
| `devops-g10-sidecar-not-running` | Container Insights `adot` |
| `devops-g10-rds-cpu-high` | `CPUUtilization` on `devops-g10-pg` > 70% / 10m |
| `devops-g10-alb-5xx` | ALB target + ELB 5xx |
| `devops-g10-external-health` | ask #1 |

Each alarm description **must** contain the GitHub runbook URL with
the matching `#anchor`.

---

## 5. k6 runner (small, same PR is fine)

k6 must reach the **internal** ALB
(`terraform output -raw alb_dns_name`). Options, cheapest first:

1. One-off Fargate task in `devops-g10-ecs-tasks` SG, image
   `grafana/k6`, command mounts
   `evidence/reliability-operations/k6/`.
2. ECS Exec onto a debug task and `k6 run` there.

Do **not** punch an inbound hole on the ALB for k6. Do **not** run
k6 from GitHub-hosted runners against API Gateway.

A Terraform `null_resource` is not required — a documented task
def `devops-g10-k6` with `desired_count = 0` is enough.

---

## Out of scope for this ask (Saloi, G3)

- Grafana dashboard JSON, SLO burn queries, 5m/1h/28d panels
- Populating `devops-g10/slack-webhook` and
  `devops-g10/grafana/sa-token`
- k6 report files under `evidence/reliability-operations/k6/reports/`

## Out of scope (already yours, just a reminder)

- `services.tf` task defs for `pos`, `payments`, `commission`
- Per-service CodePipeline / `buildspec.yml`
- Post-deploy smoke in `web-image.yml` that curls `/version` and
  fails if SHA mismatches (game-day drill 5 depends on it)
