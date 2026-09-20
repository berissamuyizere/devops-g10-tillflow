#!/usr/bin/env bash
# Put an existing Amazon Managed Grafana workspace into Terraform state
# so apply does not call CreateWorkspace again (409 Duplicate request).
#
# If the name is not in AWS, that is success: terraform apply creates it.
# ADOPT_WAIT=1 only waits when a leftover workspace already exists
# (CREATING / FAILED / DELETING). Waiting for a missing name blocks apply
# forever — nothing will appear until Terraform itself creates it.
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

seen=""
for i in $(seq 1 "${ATTEMPTS}"); do
  id="$(lookup)"
  if [[ -z "${id}" || "${id}" == "None" || "${id}" == "null" ]]; then
    echo "attempt ${i}/${ATTEMPTS}: no workspace named ${NAME}"
    if [[ -n "${seen}" ]]; then
      # FAILED delete finished; name is free for CreateWorkspace.
      echo "leftover ${NAME} is gone; apply will create it"
      exit 0
    fi
    echo "no leftover workspace; apply will create it"
    exit 0
  fi

  seen="${id}"
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

if [[ -n "${seen}" ]]; then
  echo "timed out waiting for leftover ${NAME} (${seen}) to become ACTIVE or disappear"
  exit 1
fi
echo "no Grafana workspace named ${NAME}; apply will create it"
exit 0
