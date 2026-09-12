#!/usr/bin/env sh
# Post a formatted alert to the group Slack webhook.
#
# Reads the webhook URL from AWS Secrets Manager (devops-g10/slack-webhook)
# so it is never in Git, TF state, or build logs.
#
# Contract: docs/runbook.md "Slack alert contract".
# Lambda (devops-g10-slack-notify) must emit the same fields even if it
# does not exec this script.
#
# Usage:
#   slack-notify.sh <tone: info|warning|danger> \
#     <service> <symptom> <slo-impact> <observed> \
#     <grafana-panel> <runbook-anchor> <owner> <first-action>
#
# All nine arguments after the script are required. runbook-anchor is
# the heading slug without '#', e.g. pos-5xx.

set -eu

if [ "$#" -lt 9 ]; then
  echo "usage: $0 <tone> <service> <symptom> <slo-impact> <observed> <grafana-panel> <runbook-anchor> <owner> <first-action>" >&2
  exit 2
fi

TONE="$1"
SERVICE="$2"
SYMPTOM="$3"
SLO_IMPACT="$4"
OBSERVED="$5"
GRAFANA="$6"
RUNBOOK="$7"
OWNER="$8"
FIRST_ACTION="$9"

case "$TONE" in
  info)    COLOR="#2b7cff" ;;
  warning) COLOR="#f5a623" ;;
  danger)  COLOR="#d93025" ;;
  *) echo "tone must be info|warning|danger" >&2; exit 2 ;;
esac

WEBHOOK=$(aws secretsmanager get-secret-value \
  --secret-id devops-g10/slack-webhook \
  --query 'SecretString' --output text | jq -r '.url')

if [ -z "${WEBHOOK}" ] || [ "${WEBHOOK}" = "PLACEHOLDER" ]; then
  echo "slack webhook not populated in Secrets Manager" >&2
  exit 1
fi

RUNBOOK_URL="https://github.com/berissamuyizere/devops-g10-tillflow/blob/main/docs/runbook.md#${RUNBOOK}"

PAYLOAD=$(jq -n \
  --arg color        "$COLOR" \
  --arg service      "$SERVICE" \
  --arg symptom      "$SYMPTOM" \
  --arg slo_impact   "$SLO_IMPACT" \
  --arg observed     "$OBSERVED" \
  --arg grafana      "$GRAFANA" \
  --arg runbook      "$RUNBOOK_URL" \
  --arg owner        "$OWNER" \
  --arg first_action "$FIRST_ACTION" \
  --arg env          "${ENVIRONMENT:-prod}" \
  '{
    attachments: [{
      color: $color,
      title: ("[\($env)] \($service) — \($symptom)"),
      fields: [
        { title: "Environment",      value: $env,          short: true },
        { title: "Service",          value: $service,      short: true },
        { title: "SLO impact",       value: $slo_impact,   short: false },
        { title: "Observed",         value: $observed,     short: false },
        { title: "Grafana panel",    value: $grafana,      short: false },
        { title: "Runbook",          value: $runbook,      short: false },
        { title: "Owner",            value: $owner,        short: true },
        { title: "First safe action", value: $first_action, short: false }
      ],
      footer: "devops-g10-tillflow",
      ts: (now | floor)
    }]
  }')

curl -sS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK" >/dev/null
