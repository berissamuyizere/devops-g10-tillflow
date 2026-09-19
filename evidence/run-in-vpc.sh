#!/usr/bin/env bash
# Run an evidence script as a one-off ECS Fargate task inside the VPC.
# After the edge lockdown, API Gateway stamps x-tillflow-edge=public and the
# ALB 404s stamped /internal/* — laptop curls cannot reach service tokens.
# This borrows the named service's task definition (same roles, secrets, env)
# so no extra IAM or Secrets Manager is needed.
#
# Usage:
#   evidence/run-in-vpc.sh payments scripts/g2-close-b2c.js KEY=VALUE ...
#
# Example:
#   evidence/run-in-vpc.sh payments scripts/g2-close-b2c.js \
#     TENANT_ID=... ATTENDANT_ID=... CLOSE_TRIGGER=sqs \
#     PAYMENTS_BASE_URL=http://internal-alb
set -euo pipefail

PREFIX="${PREFIX:-devops-g10}"
REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${CLUSTER:-${PREFIX}}"

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <service> <script> [KEY=VALUE ...]" >&2
  echo "  e.g. $0 payments scripts/g2-close-b2c.js TENANT_ID=... ATTENDANT_ID=..." >&2
  exit 2
fi

SERVICE="$1"
SCRIPT="$2"
shift 2

FAMILY="${PREFIX}-${SERVICE}"
LOG_GROUP="/${PREFIX}/${SERVICE}"

for pair in "$@"; do
  case "${pair}" in
    *=*) ;;
    *)
      echo "expected KEY=VALUE, got: ${pair}" >&2
      exit 2
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 2; }

SUBNETS=$(aws ecs describe-services --cluster "${CLUSTER}" --services "${FAMILY}" \
  --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')
SGS=$(aws ecs describe-services --cluster "${CLUSTER}" --services "${FAMILY}" \
  --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' --output text | tr '\t' ',')

if [ -z "${SUBNETS}" ] || [ "${SUBNETS}" = "None" ] || [ -z "${SGS}" ] || [ "${SGS}" = "None" ]; then
  echo "could not read awsvpc network config for ${FAMILY}" >&2
  exit 1
fi

# readonlyRootFilesystem: write evidence JSON to the task's /tmp volume.
OVERRIDES=$(jq -n \
  --arg script "${SCRIPT}" \
  --args -- "$@" \
  '{
    containerOverrides: [{
      name: "app",
      command: ["node", $script],
      environment: (
        [{"name":"EVIDENCE_DIR","value":"/tmp"}]
        + [($ARGS.positional[] | split("=") | {name: .[0], value: (.[1:] | join("="))})]
      )
    }]
  }')

echo "run-task ${FAMILY} node ${SCRIPT}" >&2
TASK_ARN=$(aws ecs run-task \
  --cluster "${CLUSTER}" \
  --task-definition "${FAMILY}" \
  --launch-type FARGATE \
  --region "${REGION}" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGS}],assignPublicIp=DISABLED}" \
  --overrides "${OVERRIDES}" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "${TASK_ARN}" ] || [ "${TASK_ARN}" = "None" ]; then
  echo "run-task did not return a task ARN" >&2
  exit 1
fi

TASK_ID="${TASK_ARN##*/}"
echo "task ${TASK_ARN}" >&2
aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}"

echo "--- describe-tasks ---" >&2
aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}" \
  --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}' \
  --output json

echo "--- app CloudWatch logs ---" >&2
aws logs tail "${LOG_GROUP}" --since 30m --region "${REGION}" \
  --log-stream-name-prefix "app/app/${TASK_ID}" 2>&1 || true

EXIT=$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}" \
  --query 'tasks[0].containers[?name==`app`].exitCode | [0]' --output text)
echo "exit=${EXIT}" >&2
test "${EXIT}" = "0"
