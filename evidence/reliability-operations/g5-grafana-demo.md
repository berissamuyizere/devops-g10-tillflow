# G5 Grafana — demo-proof (Saloi, ~20 minutes)

Do **not** build another dashboard. Do **not** retry Amazon Managed Grafana
SSO. Cloud is the defence login:
https://punywaxwing1700.grafana.net

Admin: Saloi (`akezasaloi@gmail.com`). Yordanos, Arsema, Berissa already
have invites.

## 1. Save a default range that shows the work (5 min)

k6 and the G4 drills are hours old. **Last 5 minutes** looks empty and
reads as “nothing works.”

1. Open **tillflow-overview**.
2. Top-right time picker → **Last 6 hours** (or **Last 24 hours** if 6h
   still looks thin).
3. **Save dashboard** so that range is the default, not only this tab.
4. Confirm budget, burn-rate, and business panels show the k6 soak, the
   Slack drill spike, and the G4 drills.

## 2. Warm every dashboard (10 minutes before you speak)

CloudWatch-backed panels are slow on first query. Open each uid once and
leave the tab until the panels finish:

| uid | Dashboard |
|---|---|
| `tillflow-overview` | Overview |
| `tillflow-web` | Web |
| `tillflow-pos` | POS |
| `tillflow-payments` | Payments |
| `tillflow-commission` | Commission |

## 3. Offline screenshots (5 min)

Save PNGs here (this folder):

`evidence/reliability-operations/screenshots/g5/`

| File | Shot |
|---|---|
| `01-overview.png` | tillflow-overview, 6h or 24h, panels populated |
| `02-web.png` | tillflow-web |
| `03-pos.png` | tillflow-pos |
| `04-payments.png` | tillflow-payments |
| `05-commission.png` | tillflow-commission |

If Grafana Cloud or the network dies mid-defence, open these. That is
the fallback. Do not improvise a new platform.

## 4. Three browser tabs at the desk

1. Grafana **overview** (warmed, saved range).
2. CloudWatch alarms, `eu-central-1` — real history from the Slack and
   G4 drills. Do not `SetAlarmState`.
3. Slack channel with the **ALARM** and **OK** messages
   (`g3-slack-drill.json`: 18:57 → 19:07 EAT).

## One sentence if they ask about AMG

“Amazon Managed Grafana `g-ede3f6a694` exists; this role cannot assign
SSO users, so defence login is Grafana Cloud.” Then move on.
