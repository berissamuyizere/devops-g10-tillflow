#!/usr/bin/env bash
# Put an existing Amazon Managed Grafana workspace into Terraform state
# so apply does not call CreateWorkspace again (409 Duplicate request).
#
# ADOPT_WAIT=1 (Release apply): poll for several minutes. Earlier 403s
# still submitted a create; the workspace shows up after SSO finishes.
# Plan job leaves ADOPT_WAIT unset so a missing workspace is a no-op.
set -euo pipefail

NAME="${1:-devops-g10-grafana}"
REGION="${AWS_REGION:-eu-central-1}"
WAIT="${ADOPT_WAIT:-0}"
ATTEMPTS=6
if [[ "${WAIT}" == "1" ]]; then
  ATTEMPTS=36
fi

if terraform state show aws_grafana_workspace.amg >/dev/null 2>&1; then
  echo "aws_grafana_workspace.amg already in state"
  exit 0
fi

lookup() {
  aws grafana list-workspaces --region "${REGION}" \
    --query "workspaces[?name=='${NAME}'].id | [0]" --output text 2>/dev/null || true
}

id=""
for i in $(seq 1 "${ATTEMPTS}"); do
  id="$(lookup)"
  if [[ -z "${id}" || "${id}" == "None" || "${id}" == "null" ]]; then
    echo "attempt ${i}/${ATTEMPTS}: no workspace named ${NAME}"
    if [[ "${WAIT}" != "1" ]]; then
      echo "plan will create it"
      exit 0
    fi
    sleep 10
    continue
  fi

  status="$(aws grafana describe-workspace --region "${REGION}" --workspace-id "${id}" \
    --query 'workspace.status' --output text)"
  echo "found ${NAME} id=${id} status=${status}"

  case "${status}" in
    ACTIVE)
      terraform import -input=false -lock-timeout=5m aws_grafana_workspace.amg "${id}"
      exit 0
      ;;
    FAILED)
      echo "deleting FAILED workspace ${id}; waiting for it to disappear"
      aws grafana delete-workspace --region "${REGION}" --workspace-id "${id}"
      sleep 15
      ;;
    DELETING)
      echo "waiting for delete"
      sleep 10
      ;;
    *)
      echo "waiting for ACTIVE"
      sleep 10
      ;;
  esac
done

if [[ "${WAIT}" == "1" ]]; then
  echo "timed out waiting for ${NAME}"
  exit 1
fi
echo "no Grafana workspace named ${NAME}; plan will create it"
exit 0
