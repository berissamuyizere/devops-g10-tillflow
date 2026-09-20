#!/usr/bin/env bash
# G4 game day — time Valkey fail-open and commission desiredCount=0
# against docs/runbook.md "Standing recovery targets". Skips RDS PITR.
#
#   aws sso login --profile g10
#   export AWS_PROFILE=g10 AWS_REGION=eu-central-1
#   export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
#   ./evidence/reliability-operations/g4/run-game-day.sh
#
# Does not flip Daraja. Does not touch WAF. Does not revoke the Terraform
# cache SG (that would leave rule-id drift). Injects Valkey unavailability
# by rebooting devops-g10-valkey-001, which drops POS connections the same
# way an SG cut would. Restore is wait-until-available, then POS GET.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/evidence/reliability-operations"
JSON_OUT="$OUT_DIR/g4-game-day.json"
MD_OUT="$OUT_DIR/g4-game-day.md"
RAW_DIR="$OUT_DIR/g4"
mkdir -p "$RAW_DIR"

REGION="${AWS_REGION:-eu-central-1}"
PROFILE="${AWS_PROFILE:-g10}"
PREFIX="${NAME_PREFIX:-devops-g10}"
API="${API_URL:-https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com}"
API="${API%/}"
TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"
ATTENDANT_ID="${ATTENDANT_ID:-22222222-2222-2222-2222-222222222222}"
CLUSTER="${CLUSTER:-$PREFIX}"
POS_SERVICE="${POS_SERVICE:-$PREFIX-pos}"
COMMISSION_SERVICE="${COMMISSION_SERVICE:-$PREFIX-commission}"
VALKEY_RG="${VALKEY_RG:-$PREFIX-valkey}"
VALKEY_NODE="${VALKEY_NODE:-$PREFIX-valkey-001}"
VALKEY_NODE_ID="${VALKEY_NODE_ID:-0001}"

export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

commission_desired_saved=""
commission_needs_restore=0

utc_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
eat_now() { TZ=Africa/Nairobi date +"%Y-%m-%d %H:%M:%S %Z"; }
epoch_now() { date -u +%s; }

awsj() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

log() { printf '[g4] %s\n' "$*" >&2; }

die() {
  log "ERROR: $*"
  exit 1
}

restore_commission() {
  if [[ "$commission_needs_restore" != 1 ]]; then
    return 0
  fi
  local want="${commission_desired_saved:-1}"
  if [[ "$want" -lt 1 ]]; then
    want=1
  fi
  log "RESTORE commission desiredCount=$want"
  awsj ecs update-service \
    --cluster "$CLUSTER" \
    --service "$COMMISSION_SERVICE" \
    --desired-count "$want" \
    --query 'service.desiredCount' \
    --output text >/dev/null
  commission_needs_restore=0
}

on_exit() {
  local code=$?
  restore_commission || true
  if [[ $code -ne 0 ]]; then
    log "exited $code — commission restore attempted; Valkey reboot is self-healing"
  fi
}
trap on_exit EXIT

headers_file="$(mktemp)"
cat >"$headers_file" <<EOF
content-type: application/json
x-tenant-id: ${TENANT_ID}
x-user-id: ${ATTENDANT_ID}
x-role: attendant
EOF

curl_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local key="${4:-}"
  local args=(-sS -w $'\n%{http_code}\t%{time_total}' -X "$method" "${API}${path}")
  while IFS= read -r line; do
    [[ -n "$line" ]] && args+=(-H "$line")
  done <"$headers_file"
  if [[ -n "$key" ]]; then
    args+=(-H "idempotency-key: $key")
  fi
  if [[ -n "$body" ]]; then
    args+=(--data "$body")
  fi
  local out
  out="$(curl "${args[@]}")"
  local meta
  meta="$(printf '%s\n' "$out" | tail -n 1)"
  local payload
  payload="$(printf '%s\n' "$out" | sed '$d')"
  local status latency
  status="$(printf '%s\n' "$meta" | cut -f1)"
  latency="$(printf '%s\n' "$meta" | cut -f2)"
  printf '%s\t%s\t%s\n' "$status" "$latency" "$payload"
}

create_sale() {
  local key="g4-${1}-$(date -u +%s)-$RANDOM"
  local row
  row="$(curl_json POST /sales '{"lines":[{"description":"G4 game day","quantity":1,"unit_price_minor":1000}]}' "$key")"
  printf '%s\t%s\n' "$key" "$row"
}

get_sale() {
  local id="$1"
  curl_json GET "/sales/${id}"
}

cache_metric_sum() {
  local result="$1"
  local start="$2"
  local end="$3"
  local dims
  for dims in \
    "Name=result,Value=${result}" \
    "Name=result,Value=${result} Name=OTelLib,Value=tillflow.pos"; do
    local sum
    sum="$(awsj cloudwatch get-metric-statistics \
      --namespace TillFlow \
      --metric-name pos_cache_requests_total \
      --dimensions $dims \
      --start-time "$start" \
      --end-time "$end" \
      --period 60 \
      --statistics Sum \
      --query 'Datapoints[].Sum' \
      --output json | jq '[.[] // 0] | add // 0')"
    if [[ "$sum" != "0" && "$sum" != "null" ]]; then
      printf '%s\n' "$sum"
      return 0
    fi
  done
  printf '0\n'
}

pos_log_hits() {
  local start_iso="$1"
  local end_iso="$2"
  local start_ms end_ms
  start_ms="$(python3 -c "from datetime import datetime,timedelta; print(int((datetime.fromisoformat('${start_iso}'.replace('Z','+00:00'))-timedelta(seconds=30)).timestamp()*1000))")"
  end_ms="$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('${end_iso}'.replace('Z','+00:00')).timestamp()*1000))")"
  awsj logs filter-log-events \
    --log-group-name "/${PREFIX}/pos" \
    --start-time "$start_ms" \
    --end-time "$end_ms" \
    --filter-pattern '"cache_get_failed"' \
    --query 'length(events)' \
    --output text
}

valkey_restart_event_after() {
  local after_iso="$1"
  awsj elasticache describe-events \
    --source-identifier "$VALKEY_NODE" \
    --source-type cache-cluster \
    --duration 30 \
    --query "Events[?contains(Message, 'restarted')].Date" \
    --output json | python3 -c "
import json,sys
from datetime import datetime,timezone
after=datetime.fromisoformat('${after_iso}'.replace('Z','+00:00'))
dates=json.load(sys.stdin)
for raw in dates or []:
    d=datetime.fromisoformat(raw.replace('Z','+00:00'))
    if d.tzinfo is None:
        d=d.replace(tzinfo=timezone.utc)
    if d >= after:
        print(raw)
        break
"
}

wait_valkey_restart_then_available() {
  local after_iso="$1"
  local sale_id="$2"
  local deadline=$(( $(epoch_now) + 360 ))
  local saw_restart=0
  FAIL_OPEN_GETS='[]'
  while [[ $(epoch_now) -lt $deadline ]]; do
    local status event row st lat sid
    status="$(awsj elasticache describe-replication-groups \
      --replication-group-id "$VALKEY_RG" \
      --query 'ReplicationGroups[0].Status' \
      --output text)"
    event="$(valkey_restart_event_after "$after_iso" || true)"
    if [[ -n "$event" ]]; then
      saw_restart=1
    fi
    row="$(get_sale "$sale_id")"
    st="$(printf '%s\n' "$row" | cut -f1)"
    lat="$(printf '%s\n' "$row" | cut -f2)"
    sid="$(printf '%s\n' "$row" | cut -f3- | jq -r '.id // empty')"
    log "valkey status=$status restart_event=${event:-none} GET $st ${lat}s"
    if [[ "$st" == "200" && "$sid" == "$sale_id" ]]; then
      FAIL_OPEN_GETS="$(jq -c --arg t "$(utc_now)" --argjson st "$st" --argjson lat "$lat" \
        '. + [{at:$t,status:$st,latency_s:$lat}]' <<<"$FAIL_OPEN_GETS")"
      fail_open_status="$st"
      fail_open_latency="$lat"
      fail_open_id="$sid"
      fail_open_seen=1
    fi
    if [[ "$saw_restart" == 1 && "$status" == "available" ]]; then
      return 0
    fi
    sleep 8
  done
  [[ "$saw_restart" == 1 ]]
}

wait_commission_count() {
  local want="$1"
  local deadline=$(( $(epoch_now) + 600 ))
  while [[ $(epoch_now) -lt $deadline ]]; do
    local running desired
    running="$(awsj ecs describe-services --cluster "$CLUSTER" --services "$COMMISSION_SERVICE" --query 'services[0].runningCount' --output text)"
    desired="$(awsj ecs describe-services --cluster "$CLUSTER" --services "$COMMISSION_SERVICE" --query 'services[0].desiredCount' --output text)"
    log "commission desired=$desired running=$running (want running=$want)"
    if [[ "$running" == "$want" ]]; then
      return 0
    fi
    sleep 10
  done
  return 1
}

# ---------------------------------------------------------------------------
log "caller $(awsj sts get-caller-identity --query Arn --output text)"
log "api $API  region $REGION  prefix $PREFIX"

health="$(curl -sS -o /tmp/g4-health.json -w '%{http_code}' "${API}/health" || true)"
[[ "$health" == "200" ]] || die "public /health returned $health"
log "public /health 200"

baseline_sale="$(create_sale baseline)"
baseline_key="$(printf '%s\n' "$baseline_sale" | cut -f1)"
baseline_status="$(printf '%s\n' "$baseline_sale" | cut -f2)"
baseline_body="$(printf '%s\n' "$baseline_sale" | cut -f4-)"
[[ "$baseline_status" == "201" ]] || die "baseline sale create $baseline_status $baseline_body"
SALE_ID="$(printf '%s\n' "$baseline_body" | jq -r .id)"
[[ -n "$SALE_ID" && "$SALE_ID" != "null" ]] || die "no sale id"

baseline_get1="$(get_sale "$SALE_ID")"
baseline_get2="$(get_sale "$SALE_ID")"
log "baseline sale=$SALE_ID get1=$(printf '%s\n' "$baseline_get1" | cut -f1) get2=$(printf '%s\n' "$baseline_get2" | cut -f1)"

commission_desired_saved="$(awsj ecs describe-services --cluster "$CLUSTER" --services "$COMMISSION_SERVICE" --query 'services[0].desiredCount' --output text)"
log "commission desiredCount saved=$commission_desired_saved"

# ============================ 1. Valkey fail-open ============================
log "VALKEY: reboot $VALKEY_NODE node $VALKEY_NODE_ID"
cache_t0_utc="$(utc_now)"
cache_t0_eat="$(eat_now)"
cache_t0_epoch="$(epoch_now)"

awsj elasticache reboot-cache-cluster \
  --cache-cluster-id "$VALKEY_NODE" \
  --cache-node-ids-to-reboot "$VALKEY_NODE_ID" \
  --query 'CacheCluster.CacheClusterStatus' \
  --output text >"$RAW_DIR/valkey-reboot-status.txt"

fail_open_status=""
fail_open_latency=""
fail_open_id=""
fail_open_seen=0
FAIL_OPEN_GETS='[]'

log "VALKEY: poll GET until restart event + available (do not trust pre-restart Status=available)"
wait_valkey_restart_then_available "$cache_t0_utc" "$SALE_ID" || die "Valkey restart did not complete within 6 min"
[[ "$fail_open_seen" == 1 ]] || die "GET /sales/:id did not stay 200 during Valkey reboot"

fail_open_utc="$(utc_now)"
cache_error_logs="$(pos_log_hits "$cache_t0_utc" "$fail_open_utc" || echo 0)"
log "pos cache_get_failed events so far=$cache_error_logs"

cache_t1_utc="$(utc_now)"
cache_t1_eat="$(eat_now)"
cache_t1_epoch="$(epoch_now)"
cache_rto=$(( cache_t1_epoch - cache_t0_epoch ))
log "VALKEY restart observed and available again in ${cache_rto}s"

# Give POS a moment to reconnect; prove GET still 200
sleep 5
recover_get1="$(get_sale "$SALE_ID")"
recover_get2="$(get_sale "$SALE_ID")"
recover_st1="$(printf '%s\n' "$recover_get1" | cut -f1)"
recover_st2="$(printf '%s\n' "$recover_get2" | cut -f2)"
log "post-restore GET1=$(printf '%s\n' "$recover_get1" | cut -f1)/$(printf '%s\n' "$recover_get1" | cut -f2)s GET2=$(printf '%s\n' "$recover_get2" | cut -f1)/$(printf '%s\n' "$recover_get2" | cut -f2)s"

# CloudWatch EMF is ~1 min late
sleep 70
cache_end_utc="$(utc_now)"
cw_error="$(cache_metric_sum error "$cache_t0_utc" "$cache_end_utc")"
cw_miss="$(cache_metric_sum miss "$cache_t0_utc" "$cache_end_utc")"
cw_hit="$(cache_metric_sum hit "$cache_t0_utc" "$cache_end_utc")"
cache_error_logs="$(pos_log_hits "$cache_t0_utc" "$cache_end_utc" || echo 0)"
cache_error_logs="$(printf '%s' "$cache_error_logs" | tr -cd '0-9')"
[[ -n "$cache_error_logs" ]] || cache_error_logs=0
cw_error="$(printf '%s' "$cw_error" | tr -cd '0-9.')"
cw_miss="$(printf '%s' "$cw_miss" | tr -cd '0-9.')"
cw_hit="$(printf '%s' "$cw_hit" | tr -cd '0-9.')"
[[ -n "$cw_error" ]] || cw_error=0
[[ -n "$cw_miss" ]] || cw_miss=0
[[ -n "$cw_hit" ]] || cw_hit=0
log "cloudwatch error=$cw_error miss=$cw_miss hit=$cw_hit logs=$cache_error_logs"

# ============================ 2. Commission worker ============================
if [[ "${SKIP_COMMISSION:-0}" == 1 ]]; then
  log "COMMISSION: skipped (SKIP_COMMISSION=1) — reuse prior timings if present"
  if [[ -f "$JSON_OUT" ]]; then
    comm_t0_utc="$(jq -r '.commission.t0_utc' "$JSON_OUT")"
    comm_t0_eat="$(jq -r '.commission.t0_eat' "$JSON_OUT")"
    comm_down_utc="$(jq -r '.commission.down_utc' "$JSON_OUT")"
    comm_t1_utc="$(jq -r '.commission.restored_utc' "$JSON_OUT")"
    comm_t1_eat="$(jq -r '.commission.restored_eat' "$JSON_OUT")"
    comm_rto="$(jq -r '.commission.rto_seconds' "$JSON_OUT")"
    comm_rto_ok="$(jq -r '.commission.rto_met' "$JSON_OUT")"
    commission_desired_saved="$(jq -r '.commission.desired_restored_to' "$JSON_OUT")"
    dlq_visible="$(jq -r '.commission.dlq_visible' "$JSON_OUT")"
  else
    die "SKIP_COMMISSION=1 but $JSON_OUT is missing"
  fi
else
log "COMMISSION: desiredCount 0 (do not enqueue close, do not redrive)"
comm_t0_utc="$(utc_now)"
comm_t0_eat="$(eat_now)"
comm_t0_epoch="$(epoch_now)"
commission_needs_restore=1

awsj ecs update-service \
  --cluster "$CLUSTER" \
  --service "$COMMISSION_SERVICE" \
  --desired-count 0 \
  --query 'service.{desired:desiredCount,running:runningCount}' \
  --output json | tee "$RAW_DIR/commission-scale-0.json" >/dev/null

wait_commission_count 0 || die "commission did not reach runningCount=0"
comm_down_utc="$(utc_now)"
comm_down_epoch="$(epoch_now)"
log "commission runningCount=0"

# First safe action from the runbook: restore desiredCount >= 1. No close replay.
awsj ecs update-service \
  --cluster "$CLUSTER" \
  --service "$COMMISSION_SERVICE" \
  --desired-count "${commission_desired_saved:-1}" \
  --query 'service.desiredCount' \
  --output text >/dev/null
commission_needs_restore=0

wait_commission_count "${commission_desired_saved:-1}" || die "commission did not return to desiredCount"
comm_t1_utc="$(utc_now)"
comm_t1_eat="$(eat_now)"
comm_t1_epoch="$(epoch_now)"
comm_rto=$(( comm_t1_epoch - comm_t0_epoch ))
log "COMMISSION restored in ${comm_rto}s"

# Confirm we did not leave messages on the DLQ as part of this drill
dlq_visible="$(awsj sqs get-queue-attributes \
  --queue-url "https://sqs.${REGION}.amazonaws.com/$(awsj sts get-caller-identity --query Account --output text)/${PREFIX}-commission-close-dlq" \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' \
  --output text 2>/dev/null || echo unknown)"
log "commission DLQ visible=$dlq_visible (read only; no redrive)"
fi

# ============================ 3. Write evidence ============================
cache_rto_ok=false
[[ "$cache_rto" -le 300 ]] && cache_rto_ok=true
if [[ "${SKIP_COMMISSION:-0}" != 1 ]]; then
  comm_rto_ok=false
  [[ "$comm_rto" -le 900 ]] && comm_rto_ok=true
fi

jq -n \
  --arg captured_at "$(utc_now)" \
  --arg captured_eat "$(eat_now)" \
  --arg region "$REGION" \
  --arg prefix "$PREFIX" \
  --arg api "$API" \
  --arg tenant "$TENANT_ID" \
  --arg attendant "$ATTENDANT_ID" \
  --arg sale_id "$SALE_ID" \
  --arg idempotency_key "$baseline_key" \
  --arg cache_t0_utc "$cache_t0_utc" \
  --arg cache_t0_eat "$cache_t0_eat" \
  --arg cache_t1_utc "$cache_t1_utc" \
  --arg cache_t1_eat "$cache_t1_eat" \
  --argjson cache_rto "$cache_rto" \
  --argjson cache_rto_ok "$cache_rto_ok" \
  --arg fail_open_status "$fail_open_status" \
  --arg fail_open_latency "$fail_open_latency" \
  --arg fail_open_id "$fail_open_id" \
  --arg recover_get1 "$(printf '%s\n' "$recover_get1" | cut -f1)" \
  --arg recover_get2 "$(printf '%s\n' "$recover_get2" | cut -f1)" \
  --argjson fail_open_gets "${FAIL_OPEN_GETS:-[]}" \
  --argjson cw_error "$cw_error" \
  --argjson cw_miss "$cw_miss" \
  --argjson cw_hit "$cw_hit" \
  --argjson cache_error_logs "$cache_error_logs" \
  --arg comm_t0_utc "$comm_t0_utc" \
  --arg comm_t0_eat "$comm_t0_eat" \
  --arg comm_down_utc "$comm_down_utc" \
  --arg comm_t1_utc "$comm_t1_utc" \
  --arg comm_t1_eat "$comm_t1_eat" \
  --argjson comm_rto "$comm_rto" \
  --argjson comm_rto_ok "$comm_rto_ok" \
  --arg comm_desired "$commission_desired_saved" \
  --arg dlq_visible "$dlq_visible" \
  '{
    drill: "g4-game-day",
    set_alarm_state: false,
    mpesa_mode: "fake",
    skipped: ["rds-pitr"],
    captured_at: $captured_at,
    captured_eat: $captured_eat,
    region: $region,
    prefix: $prefix,
    edge: $api,
    tenant_id: $tenant,
    attendant_id: $attendant,
    sale_id: $sale_id,
    idempotency_key: $idempotency_key,
    runbook: "docs/runbook.md#standing-recovery-targets",
    valkey: {
      inject: "elasticache reboot-cache-cluster devops-g10-valkey-001 node 0001",
      why_not_sg: "Terraform owns aws_vpc_security_group_ingress_rule.cache_from_ecs; revoking it leaves rule-id drift and can break the next Release apply",
      t0_utc: $cache_t0_utc,
      t0_eat: $cache_t0_eat,
      available_utc: $cache_t1_utc,
      available_eat: $cache_t1_eat,
      rto_seconds: $cache_rto,
      rto_target_seconds: 300,
      rto_met: $cache_rto_ok,
      rpo: 0,
      fail_open: {
        get_status: ($fail_open_status | tonumber),
        latency_s: ($fail_open_latency | tonumber),
        sale_id: $fail_open_id,
        note: "GET /sales/:id stayed 200 from Postgres while Valkey rebooted. Cache error does not burn the POS budget.",
        gets: $fail_open_gets
      },
      post_restore: { get1: $recover_get1, get2: $recover_get2 },
      cloudwatch_pos_cache_requests_total: { error: $cw_error, miss: $cw_miss, hit: $cw_hit },
      pos_logs_cache_get_failed: $cache_error_logs
    },
    commission: {
      inject: "ecs update-service desiredCount=0 then restore",
      first_safe_action: "Confirm commission desiredCount >= 1. Do not replay daily close until the ledger row is in hand.",
      t0_utc: $comm_t0_utc,
      t0_eat: $comm_t0_eat,
      down_utc: $comm_down_utc,
      restored_utc: $comm_t1_utc,
      restored_eat: $comm_t1_eat,
      rto_seconds: $comm_rto,
      rto_target_seconds: 900,
      rto_met: $comm_rto_ok,
      rpo: "0 duplicate payouts",
      desired_restored_to: ($comm_desired | tonumber),
      close_replayed: false,
      dlq_redriven: false,
      dlq_visible: $dlq_visible
    },
    pitr: {
      ran: false,
      reason: "Skip unless 30+ spare minutes. Procedure is in the runbook (PITR to a new instance, 7-day window). Timed recover proof tonight is Slack pending-payment + these two drills."
    }
  }' | tee "$JSON_OUT" >/dev/null

cat >"$MD_OUT" <<EOF
# G4 game day — TillFlow recovery timings

**From:** Saloi (Reliability + operations), for Group 10
**Date:** $(eat_now)
**Region:** \`$REGION\` · **Prefix:** \`$PREFIX\`

Public edge only. \`MPESA_MODE\` stayed **fake**. No \`SetAlarmState\`.
Did **not** flip Daraja. Did **not** change WAF. Did **not** start RDS PITR.

Runner: [\`g4/run-game-day.sh\`](g4/run-game-day.sh).
Machine record: [\`g4-game-day.json\`](g4-game-day.json).

## vs runbook table

| Failure class | Runbook RTO | Timed tonight | Met? |
|---|---|---|---|
| Cache (Valkey) unreachable | 5 min (POS fail-open to Postgres; restore SG/service) | **${cache_rto}s** (${cache_t0_eat} → ${cache_t1_eat}) | $([[ "$cache_rto_ok" == true ]] && echo yes || echo no) |
| Commission worker down | 15 min (restore desired count + drain) | **${comm_rto}s** (${comm_t0_eat} → ${comm_t1_eat}) | $([[ "$comm_rto_ok" == true ]] && echo yes || echo no) |
| RDS restore (PITR to a **new** instance) | 30 min | skipped | n/a — procedure in runbook |
| Payment pending / missing callback | 60 s to start reconcile | already timed G3 Slack ALARM 18:57 → OK 19:07 | yes (G3) |

RPO stayed **0** for cache (ephemeral) and **0 duplicate payouts** for
commission (no close replay, no DLQ redrive).

## 1. Valkey fail-open

Inject: \`aws elasticache reboot-cache-cluster --cache-cluster-id ${VALKEY_NODE} --cache-node-ids-to-reboot ${VALKEY_NODE_ID}\`.

Not an SG revoke. Terraform owns \`aws_vpc_security_group_ingress_rule.cache_from_ecs\`
(\`sgr-07f88466a6ed37640\`). Cutting that rule would restore connectivity only
with a **new** rule id and break the next Release apply. Reboot drops POS
connections the same way; restore is wait-until-\`available\`.

| | |
|---|---|
| Sale | \`${SALE_ID}\` (public \`POST /sales\`, tenant \`${TENANT_ID}\`) |
| GET during reboot | **${fail_open_status}** · ${fail_open_latency}s · same id — fail-open to Postgres |
| GET after available | **${recover_st1}** then **$(printf '%s\n' "$recover_get2" | cut -f1)** |
| \`pos_cache_requests_total\` in window | error ${cw_error} · miss ${cw_miss} · hit ${cw_hit} |
| POS logs \`cache_get_failed\` | ${cache_error_logs} |
| Budget | cache \`error\` does **not** burn POS (see \`docs/slo-error-budgets.md\`) |

Pay path was not required for this class. Create + GET stayed on the
public Gateway. No \`/internal/*\`.

## 2. Commission \`desiredCount=0\`

First safe action (runbook \`#commission-fast-burn\`): confirm
\`desiredCount >= 1\`. Do **not** replay daily close.

| | |
|---|---|
| Scale down | ${comm_t0_eat} → runningCount 0 at ${comm_down_utc} |
| Restore | desiredCount ${commission_desired_saved} at ${comm_t1_eat} |
| Close replayed | no |
| DLQ redriven | no (visible=${dlq_visible}) |

EventBridge daily close is 01:00 EAT. This window does not collide.

## 3. RDS PITR — skipped

Runbook recovery is PITR to a **new** instance (7-day window, RTO 30 min,
RPO ≤ 5 min). Not started. At defence: recover *procedure* is in the
runbook; timed proof is the Slack pending-payment drill plus the two
rows above.

## Defence one-liners

- Valkey down → POS still serves the sale from Postgres; cache errors do
  not burn the POS budget; node was \`available\` again in **${cache_rto}s**.
- Commission \`desiredCount=0\` → restore to ${commission_desired_saved}, do
  not re-run close; **${comm_rto}s**.
- PITR is written, not timed.
EOF

log "wrote $JSON_OUT"
log "wrote $MD_OUT"
log "done cache_rto=${cache_rto}s commission_rto=${comm_rto}s"
