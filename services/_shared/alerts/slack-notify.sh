#!/usr/bin/env sh
# Post a formatted alert to the group Slack webhook.
#
# Reads the webhook URL from AWS Secrets Manager (devops-g10/slack-webhook)
# so it is never in Git, TF state, or build logs.
#
# Usage:
#   slack-notify.sh <tone: info|warning|danger> <service> <symptom> <observed> <runbook-anchor>
#
# All arguments required. Uses the Slack alert contract from
# docs/threat-model.md / Saloi's alert contract.

set -eu

if [ "$#" -lt 5 ]; then
  echo "usage: $0 <tone> <service> <symptom> <observed> <runbook-anchor>" >&2
  exit 2
fi

TONE="$1"
SERVICE="$2"
SYMPTOM="$3"
OBSERVED="$4"
RUNBOOK="$5"

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

PAYLOAD=$(jq -n \
  --arg color   "$COLOR" \
  --arg service "$SERVICE" \
  --arg symptom "$SYMPTOM" \
  --arg observed "$OBSERVED" \
  --arg runbook "$RUNBOOK" \
  --arg env "${ENVIRONMENT:-prod}" \
  '{
    attachments: [{
      color: $color,
      title: ("[\($env)] \($service) — \($symptom)"),
      fields: [
        { title: "Observed",     value: $observed, short: false },
        { title: "Runbook",      value: ("https://github.com/berissamuyizere/devops-g10-tillflow/blob/main/docs/runbook.md#" + $runbook), short: false },
        { title: "Owner",        value: "see CODEOWNERS", short: true },
        { title: "First action", value: "see runbook", short: true }
      ],
      footer: "devops-g10-tillflow",
      ts: (now | floor)
    }]
  }')

curl -sS -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK" >/dev/null
