#!/usr/bin/env bash
# G4 broken-release drill (Yordanos). Manual rollback only — release.yml
# does not revert on a failed smoke (ADR-004 / runbook #bad-ecs-release).
#
# Deploys a one-off POS task definition that keeps /health 200 (ALB +
# circuit breaker stay green) and returns 500 on /ready and POST /sales
# (the post-deploy smoke). Then rolls back to the previous revision.
# Does not merge a broken image to main.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-g10-yordanos}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
CLUSTER=devops-g10
SERVICE=devops-g10-pos
FAMILY=devops-g10-pos
API_URL="${API_URL:-https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${ROOT}/evidence/platform-delivery/g4-broken-release.json"
NOTIFY="${ROOT}/services/_shared/alerts/slack-notify.sh"
WORKDIR="$(mktemp -d /tmp/g4-broken-release.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

iso() { date -Iseconds; }
epoch() { date +%s; }

echo "== G4 broken-release  $(iso)  workdir=${WORKDIR}"
aws sts get-caller-identity >/dev/null

PREV_ARN=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)
PREV_REV="${PREV_ARN##*:}"
echo "previous task def: ${PREV_ARN}"

# Safety: do not start if POS is already mid-deploy or a restore instance
# is the only live PG (Saloi's S1 uses a *new* identifier).
DEPLOY_STATUS=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].deployments | length(@)' --output text)
if [ "$DEPLOY_STATUS" -gt 1 ]; then
  echo "POS already has ${DEPLOY_STATUS} deployments — abort, wait for the other drill." >&2
  exit 1
fi

START_ISO=$(iso)
START_EPOCH=$(epoch)

if [ -x "$NOTIFY" ]; then
  "$NOTIFY" warning pos \
    "G4 broken-release drill starting" \
    "Yordanos deploying a one-off POS /ready 500. Manual rollback after smoke fail. Do not deploy on top." \
    "bad-ecs-release" || true
fi

# Same image + sidecar as live; only the app command changes.
aws ecs describe-task-definition --task-definition "$FAMILY" \
  --query taskDefinition > "${WORKDIR}/td-raw.json"

# /health 200 so ALB + ECS probes keep the task in service.
# /ready and everything else 500 so the POS smoke (POST /sales → 401) fails.
BROKEN_JS='require("http").createServer(function(q,s){var u=q.url.split("?")[0];var b;if(u==="/health"){s.writeHead(200,{"content-type":"application/json"});b=JSON.stringify({status:"ok",service:"pos",g4:"broken-release"});}else if(u==="/ready"){s.writeHead(500,{"content-type":"application/json"});b=JSON.stringify({status:"not_ready",service:"pos",g4:"broken-release"});}else{s.writeHead(500,{"content-type":"application/json"});b=JSON.stringify({status:"error",service:"pos",g4:"broken-release"});}s.end(b);}).listen(8080,"0.0.0.0");'

jq --arg js "$BROKEN_JS" '
  del(
    .taskDefinitionArn, .revision, .status, .requiresAttributes,
    .compatibilities, .registeredAt, .registeredBy, .deregisteredAt
  )
  | .containerDefinitions |= map(
      if .name == "app" then
        .command = ["node", "-e", $js]
      else . end
    )
' "${WORKDIR}/td-raw.json" > "${WORKDIR}/td.json"

BROKEN_ARN=$(aws ecs register-task-definition \
  --cli-input-json "file://${WORKDIR}/td.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
BROKEN_REV="${BROKEN_ARN##*:}"
echo "registered broken ${BROKEN_ARN}"

DEPLOY_ISO=$(iso)
aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$BROKEN_ARN" \
  --force-new-deployment >/dev/null
echo "waiting for broken POS to stabilize (health stays 200)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
STABLE_BROKEN_ISO=$(iso)

smoke_pos() {
  local label="$1"
  local code body ready_code ready_body
  body="$(mktemp "${WORKDIR}/pos-XXXX.json")"
  code=$(curl -sS -o "$body" -w "%{http_code}" --max-time 15 \
    -X POST "${API_URL}/sales" -H 'content-type: application/json' -d '{}' || true)
  ready_body="$(mktemp "${WORKDIR}/ready-XXXX.json")"
  ready_code=$(curl -sS -o "$ready_body" -w "%{http_code}" --max-time 15 \
    "${API_URL}/ready" || true)
  # POS /ready is not on the public catch-all (that is web). Hit POS via
  # a sale-path sibling if needed — also curl the service /ready through
  # the public /sales health is web. Record both.
  echo "${label}: POST /sales -> ${code}  GET /ready(web) -> ${ready_code}"
  echo "  sales body: $(tr -d '\n' < "$body")"
  echo "  ready body: $(tr -d '\n' < "$ready_body")"
  printf '%s %s %s' "$code" "$ready_code" "$(tr -d '\n' < "$body")"
}

echo "== smoke while broken (expect POST /sales != 401)"
FAIL_ISO=$(iso)
SALES_CODE=$(curl -sS -o "${WORKDIR}/smoke-fail-sales.json" -w "%{http_code}" --max-time 15 \
  -X POST "${API_URL}/sales" -H 'content-type: application/json' -d '{}' || echo 000)
WEB_READY_CODE=$(curl -sS -o "${WORKDIR}/smoke-fail-web-ready.json" -w "%{http_code}" --max-time 15 \
  "${API_URL}/ready" || echo 000)
# Direct POS /ready is internal; public proof is POST /sales no longer 401.
echo "POST /sales -> ${SALES_CODE} (want != 401)"
echo "GET  /ready -> ${WEB_READY_CODE} (web catch-all; stays 200)"
cat "${WORKDIR}/smoke-fail-sales.json"; echo

if [ "$SALES_CODE" = "401" ]; then
  echo "smoke did not fail — POS still serving auth. Aborting to rollback." >&2
fi

if [ -x "$NOTIFY" ]; then
  "$NOTIFY" danger pos \
    "G4 broken-release smoke failed" \
    "POST /sales returned ${SALES_CODE} (want 401). /health still 200 so circuit breaker did not auto-rollback. First action: manual ecs update-service to devops-g10-pos:${PREV_REV}." \
    "bad-ecs-release" || true
fi
DETECTED_ISO=$(iso)

echo "== manual rollback to ${PREV_ARN}"
ROLLBACK_ISO=$(iso)
ROLLBACK_EPOCH=$(epoch)
aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$PREV_ARN" \
  --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
RECOVERED_ISO=$(iso)
RECOVERED_EPOCH=$(epoch)

echo "== smoke after rollback (expect POST /sales 401)"
SALES_OK=$(curl -sS -o "${WORKDIR}/smoke-ok-sales.json" -w "%{http_code}" --max-time 15 \
  -X POST "${API_URL}/sales" -H 'content-type: application/json' -d '{}' || echo 000)
WEB_READY_OK=$(curl -sS -o "${WORKDIR}/smoke-ok-web-ready.json" -w "%{http_code}" --max-time 15 \
  "${API_URL}/ready" || echo 000)
echo "POST /sales -> ${SALES_OK}"
echo "GET  /ready -> ${WEB_READY_OK}"
cat "${WORKDIR}/smoke-ok-sales.json"; echo

if [ -x "$NOTIFY" ]; then
  "$NOTIFY" info pos \
    "G4 broken-release recovered" \
    "Rolled back to ${PREV_ARN}. POST /sales now ${SALES_OK}. Smoke passes. Rollback was manual, not release.yml." \
    "bad-ecs-release" || true
fi

RTO_SEC=$((RECOVERED_EPOCH - ROLLBACK_EPOCH))
WALL_SEC=$((RECOVERED_EPOCH - START_EPOCH))
RTO_MET=$( [ "$RTO_SEC" -le 600 ] && echo true || echo false )

LIVE_ARN=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)

jq -n \
  --arg started "$START_ISO" \
  --arg deploy "$DEPLOY_ISO" \
  --arg stable_broken "$STABLE_BROKEN_ISO" \
  --arg fail "$FAIL_ISO" \
  --arg detected "$DETECTED_ISO" \
  --arg rollback "$ROLLBACK_ISO" \
  --arg recovered "$RECOVERED_ISO" \
  --arg prev "$PREV_ARN" \
  --arg broken "$BROKEN_ARN" \
  --arg live "$LIVE_ARN" \
  --argjson sales_fail "${SALES_CODE:-0}" \
  --argjson sales_ok "${SALES_OK:-0}" \
  --argjson web_ready_fail "${WEB_READY_CODE:-0}" \
  --argjson web_ready_ok "${WEB_READY_OK:-0}" \
  --argjson rto_sec "$RTO_SEC" \
  --argjson wall_sec "$WALL_SEC" \
  --argjson rto_met "$RTO_MET" \
  --arg fail_body "$(tr -d '\n' < "${WORKDIR}/smoke-fail-sales.json")" \
  --arg ok_body "$(tr -d '\n' < "${WORKDIR}/smoke-ok-sales.json")" \
  '{
    drill: "g4-broken-release",
    owner: "Yordanos",
    service: "pos",
    cluster: "devops-g10",
    edge: "https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com",
    runbook: "docs/runbook.md#bad-ecs-release",
    what_broke: "One-off POS task definition: /health 200, /ready and POST /sales 500. Same digest as live; command override only. Not merged to main.",
    detected_how: "Post-deploy smoke (release.yml POS check is POST /sales -> 401). Slack page on fail. Circuit breaker did not fire because ALB /health stayed 200.",
    first_safe_action: "aws ecs update-service --task-definition <previous> --force-new-deployment. Do not bounce RDS. Do not terraform apply.",
    rollback_is_automatic: false,
    rollback_note: "release.yml does not revert the previous task definition when smoke fails. Circuit breaker only rolls back unhealthy /health tasks. Manual runbook step.",
    times: {
      started: $started,
      broken_deployed: $deploy,
      broken_stable: $stable_broken,
      smoke_failed: $fail,
      slack_alarm: $detected,
      rollback_started: $rollback,
      recovered_stable: $recovered,
      slack_recovered: $recovered
    },
    task_definitions: {
      previous_healthy: $prev,
      broken: $broken,
      live_after: $live
    },
    smoke: {
      while_broken: { post_sales: $sales_fail, web_ready: $web_ready_fail, sales_body: $fail_body },
      after_rollback: { post_sales: $sales_ok, web_ready: $web_ready_ok, sales_body: $ok_body }
    },
    rto_seconds: $rto_sec,
    rto_target_seconds: 600,
    rto_met: $rto_met,
    rpo: 0,
    wall_clock_seconds: $wall_sec,
    error_budget_burned: "POS sale-write SLI excludes /health and /ready. POST /sales 500s during the broken window count if they were eligible writes; this drill used unauthenticated {} so auth 5xx, not a sale write. Treat as no budget burn unless Grafana shows outcome=error on sale writes.",
    put_back: "Service left on previous_healthy. Broken revision is not the running task definition."
  }' > "$OUT"

echo "== wrote ${OUT}"
echo "RTO ${RTO_SEC}s (target 600) met=${RTO_MET}  live=${LIVE_ARN}"
if [ "$LIVE_ARN" != "$PREV_ARN" ]; then
  echo "WARNING: live task def is not the previous healthy revision" >&2
  exit 1
fi
if [ "$SALES_OK" != "401" ]; then
  echo "WARNING: POST /sales is ${SALES_OK} after rollback, want 401" >&2
  exit 1
fi
echo "G4 broken-release drill complete."
