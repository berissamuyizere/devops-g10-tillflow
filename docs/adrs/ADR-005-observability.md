# ADR-005 — Observability: Amazon Managed Grafana, not self-hosted

- **Status:** Accepted
- **Owner:** Saloi (Reliability + operations)
- **Date:** 2026-09-11
- **Area:** Reliability + operations
- **Implemented by:** Yordanos in G2 (`infra/services.tf` + Grafana
  workspace). Dashboard JSON and SLO queries are Saloi at G3.

## Context

G3 has to show 5m / 1h / 28d uptime, an SLO target line, budget
remaining, burn rate, RED, saturation, and two business signals
(sale → paid, callback lag). Apps already export OTLP to a localhost
ADOT sidecar; the sidecar writes **X-Ray** (traces) and **CloudWatch
EMF** (metrics, namespace `TillFlow`). JSON logs carry `trace_id` /
`span_id`.

We need a Grafana that four people can log into for the G5 defence,
without standing up another ECS service we then have to patch, back
up, and destroy.

## Decision

**Amazon Managed Grafana (AMG) in `eu-central-1`**, workspace name
`devops-g10-grafana`.

- **Auth:** AWS IAM Identity Center **if the account already has it
  enabled**; otherwise **AWS IAM** users/roles for the four members.
  Both are supported by AMG. We will not run Grafana's own user
  database.
- **Datasources (workspace-managed, IAM auth):** CloudWatch (metrics
  + logs Insights) and AWS X-Ray. No Amazon Managed Prometheus and no
  self-hosted Prometheus — ADOT already fans out to CloudWatch EMF.
- **Service account:** one Grafana service account token, stored in
  Secrets Manager as `devops-g10/grafana/sa-token`, used to provision
  dashboards from this repo at G3. Token never in Git, never in
  Terraform plaintext (`ignore_changes` on the secret version, same
  pattern as `devops-g10/slack-webhook`).
- **Cost envelope:** Editor seats are ~USD 9 / user / month. Four
  editors ≈ $36 / month for the remaining capstone window. Viewer
  seats for mentors if needed. Workspace itself has no extra cluster
  to pay for.
- **Retention we actually have:** CloudWatch log groups 30 days
  (ADR-004 golden path); RDS Performance Insights 7 days; X-Ray
  default 30 days. The 28-day SLO panels are therefore in-range for
  logs/traces; budget remaining is computed from CloudWatch metrics
  with a 28-day window.

ADOT config stays in SSM `/devops-g10/adot/config`. G3 may add
attributes / resource detectors there; it must not change the
exporter pair (X-Ray + EMF) without a new ADR.

## Alternatives considered

- **Self-hosted Grafana on ECS.** Full control, no per-seat fee, and
  we already have a cluster. Rejected: it is another golden-path
  service (task def, ALB rule, backups, upgrades, destroy/rebuild) in
  a week that already has POS, Payments, Commission, k6, and
  game-day. AMG is faster to defend at G5.
- **CloudWatch dashboards only.** Zero extra product. Rejected: the
  brief and G0 architecture name Grafana; SLO burn + traces + logs in
  one place is the G5 walk-through.
- **Grafana Cloud (SaaS).** Comparable UX, but a third-party tenant,
  another credential, and traces would leave AWS. Rejected for a
  capstone that already lives in one account.
- **Amazon Managed Prometheus + Grafana.** Cleaner PromQL, but we
  would pay AMP *and* have to retarget ADOT. EMF is already wired in
  `infra/ecs.tf`. Revisit only if k6 proves EMF cardinality is the
  problem.

## Consequences

- Yordanos provisions the workspace, IAM/IdC assignment for the four
  DRIs, the two datasources, and the Secrets Manager placeholder.
  Exact resources: [platform-asks-g2.md](../platform-asks-g2.md).
- Saloi owns dashboard JSON, SLO queries, and the burn alerts that
  sit *on top* of the CloudWatch alarms in [alerts.md](../alerts.md).
  CloudWatch remains the pager; Grafana is the picture.
- k6 hits the **internal ALB**, not API Gateway, so WAF rate limits
  do not become our own DoS (ADR-004). A Fargate one-off in the same
  VPC is how the G3 report is produced.
- If Identity Center is not already on, we document IAM-user auth in
  G3 evidence rather than spending the window enabling IdC.

## Proof

- This ADR + `docs/alerts.md` + `docs/runbook.md`.
- G2: Terraform that creates `devops-g10-grafana` and
  `devops-g10/grafana/sa-token` (placeholder).
- G3: dashboard screenshots and the k6 report under
  `evidence/reliability-operations/`.
- G4: game-day timings vs the RTO/RPO table in `docs/runbook.md`.
