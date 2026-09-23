#!/usr/bin/env bash
# Insert demo tenant 11111111-… on live RDS (ECS db-bootstrap + RDS master).
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${ECS_CLUSTER:-devops-g10}"
TASK_DEF="${DB_BOOTSTRAP_TASK:-devops-g10-db-bootstrap}"
POS_SERVICE="${POS_ECS_SERVICE:-devops-g10-pos}"
TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/sql/g2-seed-demo-tenant.sql"
SQL_BODY="$(cat "${SQL_FILE}")"

PSQL_SCRIPT="$(cat <<EOS
set -euo pipefail
export PGSSLMODE=require
export PGPASSWORD="\$MASTER_PASSWORD"
psql -h "\$MASTER_HOST" -p "\$MASTER_PORT" -U "\$MASTER_USER" -d "\$MASTER_DB" \\
  -v ON_ERROR_STOP=1 -v tenant_id='${TENANT_ID}' <<'SQL'
${SQL_BODY}
SQL
echo "g5 demo tenant seed ok"
EOS
)"

SUBNETS="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${POS_SERVICE}" --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')"
SGS="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${POS_SERVICE}" --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' --output text | tr '\t' ',')"

OVERRIDES="$(jq -n --arg cmd "${PSQL_SCRIPT}" '{
  containerOverrides: [{ name: "bootstrap", command: ["sh", "-c", $cmd] }]
}')"

echo "Running ${TASK_DEF} demo tenant ${TENANT_ID}…"
TASK_ARN="$(aws ecs run-task \
  --cluster "${CLUSTER}" \
  --task-definition "${TASK_DEF}" \
  --launch-type FARGATE \
  --region "${REGION}" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGS}],assignPublicIp=DISABLED}" \
  --overrides "${OVERRIDES}" \
  --query 'tasks[0].taskArn' --output text)"

aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}"
EXIT="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --region "${REGION}" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
echo "exit=${EXIT}"
[ "${EXIT}" = "0" ] || exit 1
