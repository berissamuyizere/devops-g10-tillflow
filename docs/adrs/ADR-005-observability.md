# ADR-005 — Observability, SLOs, k6, and POS cache

- **Status:** Accepted
- **Owner:** Saloi (Reliability + operations)
- **Date:** 2026-09-20
- **Area:** Reliability + operations
- **Step 0 (G3):** decided. This file is the lock.

## Context

G3 has to show live SLO panels, burn alerts, and a k6 run against the
same public edge the demo uses. Apps already export OTLP to a localhost
ADOT sidecar; the sidecar writes **X-Ray** (traces) and **CloudWatch
EMF** (metrics, namespace `TillFlow`). JSON logs carry `trace_id` /
`span_id`. Valkey is already in the account ([ADR-003](ADR-003-platform-data-services.md)).

We need one Grafana four people can log into for the G5 defence, a
frozen metric and alert contract so service PRs do not invent labels,
and a k6 path that does not punch through `/internal/*` or run
payments load from inside the VPC.

An earlier draft on `#12` (`saloi/runbook-and-alerts`) is **not** this
decision. Do not merge that PR as G3 done.

## Decision

### 1. Grafana

**Amazon Managed Grafana in `eu-central-1`**, provisioned by Terraform.

- **Login:** existing AWS SSO (IAM Identity Center). We will not run
  Grafana's own user database.
- **Dashboards:** JSON in `infra/grafana/*.json`. Saloi writes the JSON;
  Yordanos wires Terraform to load it.
- **Fallback, same day:** if this account cannot assign SSO users to
  the workspace, switch to **Grafana Cloud free**. Do not stall G3 on
  SSO assignment.

Datasources stay CloudWatch (metrics + Logs Insights) and AWS X-Ray.
No Amazon Managed Prometheus and no self-hosted Prometheus — ADOT
already fans out to CloudWatch EMF. ADOT config stays in SSM
`/devops-g10/adot/config`; G3 may add attributes, but must not change
the exporter pair (X-Ray + EMF) without a new ADR.

### 2. Metric names

Saloi has **final say** on metric names in PRs. Services emit these
names; PRs that rename or add ID-bearing labels are rejected.

**Payments (Arsema)**

| Metric | Labels |
|---|---|
| `payments_commands_total` | `kind`, `outcome` |
| `payments_callback_latency_ms` | `kind` |
| `payments_callbacks_total` | `kind`, `outcome` |
| `payments_oldest_pending_age_seconds` | `kind` |
| `payouts_by_status` | `status` |

**POS (Berissa)**

| Metric | Labels |
|---|---|
| `pos_sale_writes_total` | `outcome` |
| `pos_sale_write_latency_ms` | — |
| `pos_sales_paid_total` | — |
| `pos_cache_requests_total` | `result=hit\|miss\|error` |

**Commission (Berissa worker / Arsema payout path)**

| Metric | Labels |
|---|---|
| `commission_close_runs_total` | `outcome` |
| `commission_payouts_requested_total` | `outcome` |

**No IDs in labels.** No `tenant_id`, `sale_id`, `payment_id`,
`attendant_id`, `msisdn`, or trace id. Cardinality stays bounded.

### 3. Alerts

Burn thresholds are **error rate**, derived from the starter SLOs in
[`docs/slo-error-budgets.md`](../slo-error-budgets.md) (14.4× fast,
6× slow):

| Surface | SLO | Fast burn (page) | Slow burn (ticket) |
|---|---|---|---|
| Web / POS | 99.9% | error rate > 1.44% | error rate > 0.6% |
| Payments | 99.5% | error rate > 7.2% | error rate > 3% |
| Commission | 99.0% | error rate > 14.4% | error rate > 6% |

Also page / ticket on:

- Probe down
- Oldest pending payment age > 60s
- Commission DLQ non-empty
- Payout not settled by **06:30 EAT**

**Policy**

- Fast burn **pages the owner**.
- Slow burn **opens a ticket**.
- Budget gone → **freeze releases except fixes**.
- Resume when remaining budget **> 25% for 24h**.

**Slack:** CloudWatch alarm → SNS → Lambda. The webhook URL lives only
in Secrets Manager (`devops-g10/slack-webhook`). Posts **firing and
recovered**. Never commit the webhook.

**CPU autoscale target: 70%.** Yordanos sets ECS target tracking to
70% CPU. That is the saturation line Grafana and the runbook use.

### 4. k6 payments

k6 and the G5 demo use the **public API Gateway only**.

- Add **`POST /sales/:id/pay`** on POS (Berissa, after Yordanos Y1).
  That is the public pay path k6 and the demo hit.
- **Never** `/internal/*`.
- **Do not** run payment k6 in-VPC.

WAF still rate-limits the edge (ADR-004). Payment k6 stays inside that
envelope; it does not bypass the gateway through the internal ALB.

### 5. Cache

POS **`GET /sales/:id`** is cached in Valkey:

- **Pattern:** cache-aside.
- **Invalidate** on paid and on cancelled.
- **Fail open** to Postgres if Valkey is down. A cache error increments
  `pos_cache_requests_total{result="error"}` and still returns the
  sale; it does not 5xx the cashier.

Internal POS reads used by Payments (`GET /internal/v1/sales/:id`)
are not this cache. Service-to-service traffic stays on the contract
in [`docs/contracts/pos-payments-api.md`](../contracts/pos-payments-api.md).

## Split of work

| Who | Does |
|---|---|
| **Saloi** | This ADR, dashboard JSON, metric-name review on PRs, burn alerts, k6 against public Gateway |
| **Yordanos** | Terraform for AMG (or Grafana Cloud if SSO assignment fails), load `infra/grafana/*.json`, ECS CPU target 70% |
| **Berissa** | `POST /sales/:id/pay` after Y1; Valkey cache-aside on `GET /sales/:id` |
| **Arsema** | Emit the Payments metrics above; no IDs in labels |

All four review this PR.

## Alternatives considered

- **Self-hosted Grafana on ECS.** Another golden-path service in a
  week that already has POS, Payments, Commission, k6, and game-day.
  Rejected.
- **CloudWatch dashboards only.** The brief and G0 architecture name
  Grafana; SLO burn + traces + logs in one place is the G5 walk-through.
  Rejected as the primary picture.
- **Grafana Cloud as the first choice.** Rejected while AMG + existing
  SSO works. Kept as the **same-day fallback** if SSO users cannot be
  assigned — that is a change from the `#12` draft, which rejected
  Grafana Cloud outright.
- **k6 against the internal ALB / in-VPC.** Rejected for payments: the
  demo and the load test must see the same public edge. Internal
  routes stay locked (G2 HOLD).
- **IDs on metric labels.** Unbounded cardinality; rejected.
- **Fail-closed cache.** A Valkey outage would take `GET /sales/:id`
  down. Rejected; Postgres is the source of truth.

## Consequences

- Payments already emits these names on `develop` ([#82](https://github.com/berissamuyizere/devops-g10-tillflow/pull/82)). `payments_callback_latency_ms` keeps `kind` (stk/b2c) — two values, not an ID. Later PRs still go through Saloi for names.
- `#12` stays a skeleton. G3 proof is this ADR plus the Grafana JSON,
  the named metrics in service PRs, Slack firing **and** recovered,
  and k6 through API Gateway on `POST /sales/:id/pay`.
- If SSO assignment is blocked, Saloi and Yordanos move to Grafana
  Cloud free the same day and record the switch in G3 evidence. They
  do not wait on an account ticket.
- Payments k6 will fail until Berissa lands `POST /sales/:id/pay`.
  That is expected; k6 does not grow an `/internal` client to unblock
  itself.
- CPU at 70% is the autoscale target and the saturation panel. Do not
  retarget to 50% or 80% without a new ADR.

## Proof

- This ADR, reviewed by all four.
- G3: `infra/grafana/*.json` in Grafana (AMG or Cloud), screenshots of
  SLO / burn / RED / the two business signals, Slack firing + recovered
  for a fast-burn test, k6 report against public `POST /sales/:id/pay`.
- G3: `pos_cache_requests_total` showing hit/miss, plus a fail-open
  evidence note when Valkey is stopped.
- G4: game-day timings vs the runbook RTO/RPO table.
