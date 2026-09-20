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
| Grafana | Grafana Cloud `punywaxwing1700` — https://punywaxwing1700.grafana.net (ADR-005 fallback). AMG `g-ede3f6a694` stays up; SSO assignment is denied |
| Dashboards | uids `tillflow-overview`, `tillflow-web`, `tillflow-pos`, `tillflow-payments`, `tillflow-commission` from `infra/grafana/*.json` |
| Metrics | CloudWatch namespace `TillFlow` after the forced image rebuild ([35519412591](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35519412591), SHA `3b0fd3f1`) and Arsema’s public pay+trace ([#112](https://github.com/berissamuyizere/devops-g10-tillflow/pull/112)) |
| Slack | SNS `devops-g10-alerts` → Lambda `devops-g10-slack-notifier` → secret `devops-g10/slack-webhook` |
| k6 smoke | [`k6/g3-public-pay.js`](../evidence/reliability-operations/k6/g3-public-pay.js) — 12/12 |
| k6 load | [`k6-g3-full.json`](../evidence/reliability-operations/k6-g3-full.json) + [`k6-analysis.md`](../evidence/reliability-operations/k6-analysis.md). 22m full envelope 2026-09-20 19:53–20:15 EAT. 2374 iter, checks 9494/9496, HTTP p95 253 ms. WAF 2000 only for that window; **200** again at 20:15 EAT. |
| Budget | `infra/grafana/overview.json` panels 11–14: web / POS / payments / commission **budget remaining** over 28d |
| Y6 CPU | Live: POS + Payments target-tracking **70** (`devops-g10-pos-cpu-70`, `devops-g10-payments-cpu-70`), min 2 / max 4. Confirmed 2026-09-20 19:52 EAT after [#118](https://github.com/berissamuyizere/devops-g10-tillflow/actions/runs/35522942351) migrate green. |

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

Amazon Managed Grafana `devops-g10-grafana` (`g-ede3f6a694`) is **ACTIVE**.
Terraform loaded the five `tillflow-*` dashboards via a service account.
IAM Identity Center login is **blocked**.

The g10 permission set has an **explicit deny** on
`sso:ListDirectoryAssociations` and `sso:DescribeInstance` for
`arn:aws:sso:::instance/ssoins-7223e79b35125954`. Console
**Assign user** (2026-09-20 19:27 EAT) failed with that deny. Grafana
URL returns `sso.auth.access-denied` because **no users are assigned**.
This role cannot fix that.

ADR-005 same-day fallback: **Grafana Cloud free** stack
`punywaxwing1700` — https://punywaxwing1700.grafana.net
JSON in `infra/grafana/*.json` stays the contract. Invite all four;
CloudWatch in `eu-central-1`. Saloi logged into this Cloud org
**2026-09-20 19:30 EAT** (`akezasaloi@gmail.com`, Admin).

## Budget remaining (28d)

Overview panels 11–14, formula
`1 − (errors ÷ (eligible × (1 − SLO target)))`:

| Panel | Service | Target | Slack `(1 − target)` |
|---|---|---|---|
| 11 | Web | 99.9% | 0.001 |
| 12 | POS | 99.9% | 0.001 |
| 13 | Payments | 99.5% | 0.005 |
| 14 | Commission | 99.0% | 0.01 |

Freeze at remaining 0; resume when **> 25% for 24h**.

## k6 envelope

Smoke (S7) plus full envelope 2026-09-20 19:53–20:15 EAT: smoke +
stepped baseline + 30s spike + **15 min soak**. Highest sustained:
**2 paid-sale flows/s**. WAF 200 → 2000 → **200** the same evening.
See [`k6-analysis.md`](../evidence/reliability-operations/k6-analysis.md).

## Sign-off

| Name | Role | Signed |
|---|---|---|
| Saloi | Reliability | 2026-09-20 20:16 EAT |
| Yordanos | Platform | 2026-09-20 21:11 EAT |
| Arsema | Payments | |
| Berissa | Product + POS | |

## Not claimed

- Real Daraja.
- Amazon Managed Grafana human login (workspace exists; SSO assignment denied).
- Merging [#12](https://github.com/berissamuyizere/devops-g10-tillflow/pull/12).
