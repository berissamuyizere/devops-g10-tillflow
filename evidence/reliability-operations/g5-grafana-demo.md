# G5 Grafana — demo-proof

Defence login is Grafana Cloud, not Amazon Managed Grafana:

https://punywaxwing1700.grafana.net

Admin: Saloi (`akezasaloi@gmail.com`). Yordanos, Arsema, Berissa already
have invites. Default range on the JSON (and on the live overview) is
**Last 24 hours** so last night’s k6 soak is visible.

## Offline fallback

[`screenshots/g5/`](screenshots/g5/) — five signed-in PNGs, 13:50 EAT.

## Warm 10 minutes before you speak

CloudWatch-backed panels are slow on first query. Open each uid once:

| uid | Dashboard |
|---|---|
| `tillflow-overview` | Overview |
| `tillflow-web` | Web |
| `tillflow-pos` | POS |
| `tillflow-payments` | Payments |
| `tillflow-commission` | Commission |

## Three browser tabs at the desk

1. Grafana **overview** (warmed, Last 24 hours).
2. CloudWatch alarms, `eu-central-1` — real history from the Slack and
   G4 drills. Do not `SetAlarmState`.
3. Slack channel with the **ALARM** and **OK** messages
   (`g3-slack-drill.json`: 18:57 → 19:07 EAT).

## If they ask about empty panels

Green **No data** on error-rate stats is zero errors (CloudWatch has no
error samples), not a broken dashboard. Red **No data** on the four
28-day budget remaining panels is the SEARCH window; freeze math is
still in [`docs/slo-error-budgets.md`](../../docs/slo-error-budgets.md).
Oldest pending climbing is fake-mode; do not `SetAlarmState`.
Web ALB 5xx / request count / target p95 are empty — probe and ECS CPU
are the live web story.

## One sentence if they ask about AMG

Amazon Managed Grafana `g-ede3f6a694` exists; this role cannot assign
SSO users, so defence login is Grafana Cloud. Then move on.
