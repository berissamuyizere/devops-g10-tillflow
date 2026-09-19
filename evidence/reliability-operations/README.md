# evidence/reliability-operations

DRI: Saloi (Reliability + operations). Cross-reviewer: Yordanos.

## What lands here

| Gate | Artifact |
|---|---|
| G3 | k6 summaries in `k6/reports/` (scripts are already in `k6/`) |
| G3 | Slack stub-alarm screenshot + Lambda log (contract fields) |
| G3 | Grafana dashboard screenshots: 5m/1h/28d uptime, SLO line, budget remaining, burn, RED, saturation |
| G4 | `game-day/<n>-<name>/` with the capture template from [`docs/game-day.md`](../../docs/game-day.md) |
| G5 | destroy/rebuild note + cost snapshot |

Do not commit webhook URLs, Daraja secrets, or real MSISDNs.

## After the G1 apply

Populate the Slack webhook (never in Git):

```bash
aws secretsmanager put-secret-value \
  --secret-id devops-g10/slack-webhook --region eu-central-1 \
  --secret-string file://webhook.json
```

Then wait for Yordanos' G2 stub alarm and fire it once — see
[`docs/platform-asks-g2.md`](../../docs/platform-asks-g2.md) ask #3.
