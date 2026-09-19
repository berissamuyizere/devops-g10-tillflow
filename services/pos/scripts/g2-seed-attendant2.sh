#!/usr/bin/env bash
# Seed a demo attendant on live RDS (ECS run-task + psql as RDS master).
# Override ATTENDANT_ID / ATTENDANT_EMAIL / ATTENDANT_NAME to seed another one.
# Requires AWS CLI credentials with ecs:RunTask + logs read on devops-g10.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${ECS_CLUSTER:-devops-g10}"
TASK_DEF="${DB_BOOTSTRAP_TASK:-devops-g10-db-bootstrap}"
POS_SERVICE="${POS_ECS_SERVICE:-devops-g10-pos}"

TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"
ATTENDANT_ID="${ATTENDANT_ID:-33333333-3333-3333-3333-333333333333}"
ATTENDANT_EMAIL="${ATTENDANT_EMAIL:-demo2@tillflow.dev}"
ATTENDANT_NAME="${ATTENDANT_NAME:-Demo Attendant 2}"
PAYOUT_MSISDN="${PAYOUT_MSISDN:-254700000000}"
COMMISSION_BPS="${COMMISSION_BPS:-500}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SQL_FILE="${SCRIPT_DIR}/sql/g2-seed-attendant2.sql"
VERIFY_SQL_FILE="${SCRIPT_DIR}/sql/g2-verify-attendant2.sql"
EVIDENCE_FILE="${EVIDENCE_FILE:-${REPO_ROOT}/evidence/product-pos/g2-seed-${ATTENDANT_ID%%-*}.json}"

if [ ! -f "${SQL_FILE}" ] || [ ! -f "${VERIFY_SQL_FILE}" ]; then
  echo "missing seed or verify SQL under ${SCRIPT_DIR}/sql/" >&2
  exit 2
fi

SQL_BODY="$(cat "${SQL_FILE}")"
VERIFY_BODY="$(cat "${VERIFY_SQL_FILE}")"

PSQL_SCRIPT="$(cat <<EOS
set -euo pipefail
export PGSSLMODE=require
export PGPASSWORD="\$MASTER_PASSWORD"
psql -h "\$MASTER_HOST" -p "\$MASTER_PORT" -U "\$MASTER_USER" -d "\$MASTER_DB" \\
  -v ON_ERROR_STOP=1 \\
  -v tenant_id='${TENANT_ID}' \\
  -v attendant_id='${ATTENDANT_ID}' \\
  -v attendant_email='${ATTENDANT_EMAIL}' \\
  -v display_name='${ATTENDANT_NAME}' \\
  -v payout_msisdn='${PAYOUT_MSISDN}' \\
  -v commission_bps='${COMMISSION_BPS}' <<'SQL'
${SQL_BODY}
SQL
echo "g2 seed attendant2 ok"
psql -h "\$MASTER_HOST" -p "\$MASTER_PORT" -U "\$MASTER_USER" -d "\$MASTER_DB" \\
  -v ON_ERROR_STOP=1 \\
  -v tenant_id='${TENANT_ID}' \\
  -v attendant_id='${ATTENDANT_ID}' <<'VERIFY'
${VERIFY_BODY}
VERIFY
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

echo "Running ${TASK_DEF} seed (attendant ${ATTENDANT_ID}) on ${CLUSTER}…"
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
LOGS="$(aws logs tail "/devops-g10/db-migrate" --since 30m --region "${REGION}" \
  --log-stream-name-prefix "bootstrap/bootstrap/${TASK_ID}" 2>&1 || true)"
echo "${LOGS}"

echo "exit=${EXIT}"
if [ "${EXIT}" != "0" ]; then
  echo "seed failed" >&2
  exit 1
fi

# `aws logs tail` prefixes each line with a timestamp and stream name, so keep
# only from the first brace onward before handing it to jq.
DB_EVIDENCE="$(echo "${LOGS}" | awk '/__SEED_EVIDENCE__/{getline; print; exit}' | sed 's/^[^{]*//')"
if [ -z "${DB_EVIDENCE}" ]; then
  echo "could not parse __SEED_EVIDENCE__ from CloudWatch logs" >&2
  exit 1
fi

if ! echo "${DB_EVIDENCE}" | jq -e '.attendant.id and .user.id and .membership.role' >/dev/null 2>&1; then
  echo "verify query returned incomplete rows:" >&2
  echo "${DB_EVIDENCE}" >&2
  exit 1
fi

CAPTURED_AT="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
mkdir -p "$(dirname "${EVIDENCE_FILE}")"
jq -n \
  --arg captured_at "${CAPTURED_AT}" \
  --arg method "ecs run-task ${TASK_DEF} with psql as RDS master (container override)" \
  --arg task_arn "${TASK_ARN}" \
  --argjson exit_code "${EXIT}" \
  --argjson db "${DB_EVIDENCE}" \
  '{
    captured_at: $captured_at,
    method: $method,
    task_arn: $task_arn,
    exit_code: $exit_code,
    tenant: $db.tenant,
    user: $db.user,
    membership: $db.membership,
    attendant: ($db.attendant + { role: $db.membership.role }),
    notes: ("G2 close evidence: use ATTENDANT_ID=" + $db.attendant.id + ". Does not touch existing ledger rows.")
  }' > "${EVIDENCE_FILE}"

echo "evidence written to ${EVIDENCE_FILE}"
echo ""
echo "Attendant ${ATTENDANT_ID} is seeded."
echo "Run the close evidence with ATTENDANT_ID=${ATTENDANT_ID}."
