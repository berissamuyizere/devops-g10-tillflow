#!/usr/bin/env bash
# G5 — re-seed demo tenant + attendant 2222… after stack rebuild (Berissa).
set -euo pipefail

API_URL="${API_URL:-https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com}"
REGION="${AWS_REGION:-eu-central-1}"

echo "Checking ${API_URL}/health …"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${API_URL}/health" || true)"
if [ "${CODE}" != "200" ]; then
  echo "API /health is ${CODE}, not 200. Wait for Yordanos before seeding." >&2
  exit 1
fi

export AWS_REGION="${REGION}"
export TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"
export ATTENDANT_ID="${ATTENDANT_ID:-22222222-2222-2222-2222-222222222222}"
export ATTENDANT_EMAIL="${ATTENDANT_EMAIL:-demo@tillflow.dev}"
export ATTENDANT_NAME="${ATTENDANT_NAME:-Demo Attendant}"
export PAYOUT_MSISDN="${PAYOUT_MSISDN:-254700000000}"
export COMMISSION_BPS="${COMMISSION_BPS:-500}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
export EVIDENCE_FILE="${EVIDENCE_FILE:-${REPO_ROOT}/evidence/product-pos/g2-seed.json}"

echo "Seeding demo tenant ${TENANT_ID} …"
bash "${SCRIPT_DIR}/g2-seed-demo-tenant.sh"

echo "Seeding attendant ${ATTENDANT_ID} …"
cd "${SCRIPT_DIR}/.."
npm run g2:seed-attendant2

if [ "${RUN_CLOSE_SEED:-0}" = "1" ]; then
  echo "Running g2:close-seed on ${API_URL} …"
  export API_URL
  TOKENS="$(aws secretsmanager get-secret-value \
    --secret-id devops-g10/service-tokens \
    --region "${REGION}" \
    --query SecretString --output text)"
  export PAYMENTS_SERVICE_TOKEN="$(echo "$TOKENS" | jq -r .payments_service_token)"
  export POS_SERVICE_TOKEN="$(echo "$TOKENS" | jq -r .pos_service_token)"
  export DARAJA_CALLBACK_SECRET="$(echo "$TOKENS" | jq -r .daraja_callback_secret)"
  npm run g2:close-seed
fi

echo "G5 post-rebuild seed complete."
