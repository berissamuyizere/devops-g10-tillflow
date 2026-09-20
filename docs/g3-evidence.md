# G3 evidence — TillFlow reliability

**From:** Saloi (Reliability + operations), for Group 10
**Date:** 2026-09-20
**Region:** `eu-central-1` · **Prefix:** `devops-g10-`

Public edge only. `MPESA_MODE` stayed **fake**. Slack webhook is in Secrets
Manager, never Git. [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12)
is not this work.

## What is live

| Item | Pointer |
|---|---|
| Grafana | Amazon Managed Grafana `g-ede3f6a694` — https://g-ede3f6a694.grafana-workspace.eu-central-1.amazonaws.com |
| Dashboards | uids `tillflow-overview`, `tillflow-web`, `tillflow-pos`, `tillflow-payments`, `tillflow-commission` from `infra/grafana/*.json` |
| Metrics | CloudWatch namespace `TillFlow` after the forced image rebuild ([35519412591](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35519412591), SHA `3b0fd3f1`) and Arsema’s public pay+trace ([#112](https://github.com/berissamuyizere/devops-g10-tillflow/pull/112)) |
| Slack | SNS `devops-g10-alerts` → Lambda `devops-g10-slack-notifier` → secret `devops-g10/slack-webhook` |
| k6 | [`evidence/reliability-operations/k6/g3-public-pay.js`](../evidence/reliability-operations/k6/g3-public-pay.js) |

### TillFlow series confirmed

`payments_commands_total`, `payments_callbacks_total`,
`payments_callback_latency_ms`, `payments_oldest_pending_age_seconds`,
`payouts_by_status`, `pos_sale_writes_total`, `pos_sale_write_latency_ms`,
`pos_sales_paid_total`, `pos_cache_requests_total`,
`commission_close_runs_total`. Labels stay bounded (no IDs). EMF also
stamps `OTelLib=tillflow.payments` / `tillflow.pos`.

## S6 — Slack webhook

`devops-g10/slack-webhook` last changed **2026-09-20 18:49 EAT**. Shape
`{"url":"<string>"}`. Not `PLACEHOLDER`. File used for `put-secret-value`
was deleted. Lambda reads the secret on every invoke
(`infra/lambda/slack_notifier/index.py`).

## S7 — k6 on public `POST /sales/:id/pay`

[`evidence/reliability-operations/g3-k6-public-pay.txt`](../evidence/reliability-operations/g3-k6-public-pay.txt)

Against `https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com`.
1 VU × 3 iterations. Payer `254700000000`. **12/12 checks**,
`http_req_failed` 0%. Path: sale → pay → signed `/payments/callback` →
sale `paid`. No `/internal/*`.

## S8 — Slack firing and recovered

[`evidence/reliability-operations/g3-slack-drill.json`](../evidence/reliability-operations/g3-slack-drill.json)

Not `SetAlarmState`. Symptom was a real pending STK (pre-existing
timeout `254700000003` on sale `52586a6c-…`, plus G3 no-callback
`254700000004` on sale `0544ef3e-…`). First safe action: signed callback,
do not mark failed.

| | EAT | Proof |
|---|---|---|
| OK → **ALARM** | 18:57:37 | CloudWatch history; SNS 1 message; Lambda `aec6d216-…` 1126 ms; no `placeholder` log |
| ALARM → **OK** | 19:07:37 | History; SNS 1 message; Lambda `604172ba-…` 704 ms; datapoint `0.0` |

The alarm was blind until the payment query included `OTelLib` (kind-only
never matched EMF). That match is in `infra/alarms.tf` and already live.
The payout query stays kind-only so G2 timeout rows left `disbursing`
do not pin a page.

## Grafana login

Workspace is **ACTIVE**, SSO auth, dashboards loaded by the Terraform
service account. This permission set **cannot** `grafana:UpdatePermissions`
/ `sso:ListInstances` (`AccessDenied` / “Unable to update users in managed
application”). Assignment is the out-of-band console step in
`infra/grafana.tf`: Amazon Managed Grafana → `devops-g10-grafana` →
Authentication → assign the four cohort users as Admin.

Open https://g-ede3f6a694.grafana-workspace.eu-central-1.amazonaws.com
with the existing IAM Identity Center user. Grafana Cloud is the ADR-005
same-day fallback only if that login is refused.

## Not claimed

- Real Daraja.
- Grafana Cloud (AMG is up).
- Y6 CPU 70% retune.
- Merging [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).
