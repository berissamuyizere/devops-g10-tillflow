#!/usr/bin/env bash
# Adopt a Grafana workspace that AWS already created (failed apply still
# left it in CREATING/ACTIVE) so terraform plan does not call
# CreateWorkspace again (409 Duplicate request for workspace).
set -euo pipefail

NAME="${1:-devops-g10-grafana}"
REGION="${AWS_REGION:-eu-central-1}"

if terraform state show aws_grafana_workspace.amg >/dev/null 2>&1; then
  echo "aws_grafana_workspace.amg already in state"
  exit 0
fi

id=""
for _ in $(seq 1 60); do
  id="$(aws grafana list-workspaces --region "${REGION}" \
    --query "workspaces[?name=='${NAME}'].id | [0]" --output text 2>/dev/null || true)"
  if [[ -z "${id}" || "${id}" == "None" || "${id}" == "null" ]]; then
    echo "no Grafana workspace named ${NAME}; plan will create it"
    exit 0
  fi

  status="$(aws grafana describe-workspace --region "${REGION}" --workspace-id "${id}" \
    --query 'workspace.status' --output text)"
  echo "found ${NAME} id=${id} status=${status}"

  case "${status}" in
    ACTIVE)
      terraform import -input=false -lock-timeout=5m aws_grafana_workspace.amg "${id}"
      exit 0
      ;;
    FAILED|DELETING)
      echo "workspace is ${status}; not importing"
      exit 0
      ;;
    *)
      echo "waiting for ACTIVE"
      sleep 10
      ;;
  esac
done

echo "timed out waiting for ${NAME} to become ACTIVE"
exit 1
