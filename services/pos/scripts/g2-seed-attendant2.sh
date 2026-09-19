#!/usr/bin/env bash
# Seed demo attendant #2 on live RDS (same ECS path as g2-seed.json).
# Requires AWS CLI credentials with ecs:RunTask + logs read on devops-g10.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${ECS_CLUSTER:-devops-g10}"
TASK_DEF="${DB_BOOTSTRAP_TASK:-devops-g10-db-bootstrap}"
POS_SERVICE="${POS_ECS_SERVICE:-devops-g10-pos}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SQL_FILE="${SCRIPT_DIR}/sql/g2-seed-attendant2.sql"
EVIDENCE_FILE="${EVIDENCE_FILE:-${REPO_ROOT}/evidence/product-pos/g2-seed-attendant2.json}"

if [ ! -f "${SQL_FILE}" ]; then
  echo "missing ${SQL_FILE}" >&2
  exit 2
fi

SQL_BODY="$(cat "${SQL_FILE}")"

PSQL_SCRIPT="$(cat <<EOS
set -euo pipefail
export PGSSLMODE=require
export PGPASSWORD="\$MASTER_PASSWORD"
psql -h "\$MASTER_HOST" -p "\$MASTER_PORT" -U "\$MASTER_USER" -d "\$MASTER_DB" \\
  -v ON_ERROR_STOP=1 <<'SQL'
${SQL_BODY}
SQL
echo "g2 seed attendant2 ok"
EOS
)"

SUBNETS="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${POS_SERVICE}" --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')"
SGS="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${POS_SERVICE}" --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' --output text | tr '\t' ',')"

OVERRIDES="$(jq -n --arg cmd "${PSQL_SCRIPT}" '{
  containerOverrides: [{
    name: "bootstrap",
    command: ["sh", "-c", $cmd]
  }]
}')"

echo "Running ${TASK_DEF} seed (attendant 3333…) on ${CLUSTER}…"
TASK_ARN="$(aws ecs run-task \
  --cluster "${CLUSTER}" \
  --task-definition "${TASK_DEF}" \
  --launch-type FARGATE \
  --region "${REGION}" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGS}],assignPublicIp=DISABLED}" \
  --overrides "${OVERRIDES}" \
  --query 'tasks[0].taskArn' --output text)"

TASK_ID="${TASK_ARN##*/}"
echo "task ${TASK_ARN}"
aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}"

EXIT="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}" \
  --query 'tasks[0].containers[0].exitCode' --output text)"

echo "--- CloudWatch (last 30m) ---"
aws logs tail "/devops-g10/db-migrate" --since 30m --region "${REGION}" \
  --log-stream-name-prefix "bootstrap/bootstrap/${TASK_ID}" 2>&1 || true

echo "exit=${EXIT}"
if [ "${EXIT}" != "0" ]; then
  echo "seed failed" >&2
  exit 1
fi

CAPTURED_AT="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
mkdir -p "$(dirname "${EVIDENCE_FILE}")"
jq -n \
  --arg captured_at "${CAPTURED_AT}" \
  --arg method "ecs run-task ${TASK_DEF} with psql as RDS master (container override)" \
  --arg task_arn "${TASK_ARN}" \
  --argjson exit_code "${EXIT}" \
  '{
    captured_at: $captured_at,
    method: $method,
    task_arn: $task_arn,
    exit_code: $exit_code,
    tenant: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Demo Café"
    },
    user: {
      id: "33333333-3333-3333-3333-333333333333",
      email: "demo2@tillflow.dev"
    },
    attendant: {
      id: "33333333-3333-3333-3333-333333333333",
      tenant_id: "11111111-1111-1111-1111-111111111111",
      display_name: "Demo Attendant 2",
      payout_msisdn: "254700000000",
      commission_bps: 500,
      status: "active",
      role: "attendant"
    },
    notes: "For Arsema G2 close: use ATTENDANT_ID=33333333-3333-3333-3333-333333333333 in g2-close-seed.js. Do not delete 2222… ledger for 2026-09-18."
  }' > "${EVIDENCE_FILE}"

echo "evidence written to ${EVIDENCE_FILE}"
echo ""
echo "Tell Arsema: attendant 33333333-3333-3333-3333-333333333333 is seeded."
echo "She can run g2-close-seed with ATTENDANT_ID=33333333-3333-3333-3333-333333333333 then CLOSE_TRIGGER=manual."
