# Game day — TillFlow (G4)

**Owner (DRI):** Saloi (Reliability + operations)
**Runs:** Saloi + Arsema for drills 1–4; Yordanos for 5–6; Berissa
joins drill 1's sale-replay check
**When:** 19–20 Sep 2026
**Clock:** RTO/RPO in [`runbook.md`](runbook.md#standing-recovery-targets)

Capture start, first-safe-action, restored, and data-loss for every
drill in `evidence/reliability-operations/game-day/<n>-<name>/`. No
real MSISDNs, no secret values.

k6 and these drills talk to the **internal ALB** (or a local compose
stack). Do not put game-day load through API Gateway — WAF is 200
req / 5 min / IP (ADR-004).

`MPESA_MODE=fake` for every money-path drill. The fake MSISDNs are
the break handles ([`services/_shared/mpesa`](../services/_shared/mpesa/README.md)).

---

## 1. STK timeout

**Proves:** a Daraja timeout is not a decline. Payment stays
`pending`; sale does not become `cancelled` or `paid`
([ADR-002](adrs/ADR-002-idempotency-and-replay-safety.md)).

**How to break it**

```bash
# Fake adapter: last digit 3 → stkPush throws MpesaTimeoutError,
# payment remains in-flight so a later stkQuery can settle it.
# Create a sale first (Berissa's POS), then:
curl -sS -X POST "$PAYMENTS_URL/internal/v1/charges" \
  -H "Content-Type: application/json" \
  -H "X-Pos-Token: $POS_SERVICE_TOKEN" \
  -H "Idempotency-Key: gameday-stk-timeout-1" \
  -d '{"sale_id":"'"$SALE_ID"'","msisdn":"254700000003"}' \
  | tee evidence/reliability-operations/game-day/1-stk-timeout/charge.json

# Expect: 201, status=pending (NOT failed). timed_out must be false.
jq '{id, status, timed_out, checkout_request_id}' \
  evidence/reliability-operations/game-day/1-stk-timeout/charge.json
```

**Pass**

```bash
curl -sS "$PAYMENTS_URL/internal/v1/payments/$PAYMENT_ID" \
  -H "X-Pos-Token: $POS_SERVICE_TOKEN" | jq .status
# pending

curl -sS "$POS_URL/internal/v1/sales/$SALE_ID" \
  -H "X-Payments-Token: $PAYMENTS_SERVICE_TOKEN" | jq .status
# created or awaiting_payment — never cancelled, never paid

# Reconcile settles it; this is the recovery, not the break.
curl -sS -X POST "$PAYMENTS_URL/internal/v1/payments/$PAYMENT_ID/reconcile" \
  -H "X-Pos-Token: $POS_SERVICE_TOKEN" | jq '{status, reconcile_reason}'
```

**RTO clock:** time from timeout to reconcile started (target: 60s to
*start*, not to finish). **RPO:** 0 extra charges.

---

## 2. Callback replay

**Proves:** a second success callback is a no-op; one charge, one
`paid_at`. HMAC is over `${t}.${rawBody}` so a captured callback
replays for 300s ([threat model](threat-model.md)).

**How to break it**

```bash
# Charge a success-path sale (MSISDN ends in 0).
curl -sS -X POST "$PAYMENTS_URL/internal/v1/charges" \
  -H "Content-Type: application/json" \
  -H "X-Pos-Token: $POS_SERVICE_TOKEN" \
  -H "Idempotency-Key: gameday-callback-replay-1" \
  -d '{"sale_id":"'"$SALE_ID"'","msisdn":"254700000000"}' \
  | tee evidence/reliability-operations/game-day/2-callback-replay/charge.json

# Build the Daraja envelope from the fake (CI) or pull raw_body from
# payments.callback_log after the first real callback. Sign it the
# same way the transport does:
node - <<'JS'
const { sign } = require('./services/_shared/mpesa/signature');
const body = require('./evidence/reliability-operations/game-day/2-callback-replay/callback-body.json');
const raw = JSON.stringify(body);
const secret = process.env.DARAJA_CALLBACK_SECRET || 'dev-callback-secret';
const header = sign(raw, secret, Date.now() / 1000);
require('fs').writeFileSync('/tmp/cb.headers', header);
require('fs').writeFileSync('/tmp/cb.raw', raw);
console.log(header);
JS

# First apply
curl -sS -D - -X POST "$PAYMENTS_URL/payments/callback" \
  -H "Content-Type: application/json" \
  -H "X-TillFlow-Signature: $(cat /tmp/cb.headers)" \
  --data-binary @/tmp/cb.raw \
  | tee evidence/reliability-operations/game-day/2-callback-replay/first.txt

# Immediate replay — same body, same signature (still inside 300s)
curl -sS -D - -X POST "$PAYMENTS_URL/payments/callback" \
  -H "Content-Type: application/json" \
  -H "X-TillFlow-Signature: $(cat /tmp/cb.headers)" \
  --data-binary @/tmp/cb.raw \
  | tee evidence/reliability-operations/game-day/2-callback-replay/second.txt
```

**Pass:** first response `applied=true` / `status=paid`; second
`replay=true`. One row in `payments.payments`. `callback_log` has one
`applied` row (replays of an already-applied hash collapse on the
partial unique index). Sale `paid_at` did not move.

Berissa's sale-replay drill (same `Idempotency-Key` twice) is the POS
half of this — run it in the same window.

**RTO:** n/a (correctness). **RPO:** 0 duplicate charges.

---

## 3. Cache down

**Proves:** Valkey is cache-aside, not the source of truth. POS and
Payments keep serving (possibly slower). Alert `rds-cpu-high` may
follow; `sidecar-not-running` must not.

**How to break it**

```bash
CACHE_SG=$(aws ec2 describe-security-groups --region eu-central-1 \
  --filters Name=group-name,Values=devops-g10-cache \
  --query 'SecurityGroups[0].GroupId' --output text)
ECS_SG=$(aws ec2 describe-security-groups --region eu-central-1 \
  --filters Name=group-name,Values=devops-g10-ecs-tasks \
  --query 'SecurityGroups[0].GroupId' --output text)

# Revoke the only ingress. Do NOT delete the replication group.
aws ec2 revoke-security-group-ingress --region eu-central-1 \
  --group-id "$CACHE_SG" \
  --protocol tcp --port 6379 \
  --source-group "$ECS_SG"

# Prove app liveness still holds:
curl -sSf "$ALB_URL/health"
curl -sS "$ALB_URL/ready" ; echo
```

**Restore** (this is the RTO clock)

```bash
aws ec2 authorize-security-group-ingress --region eu-central-1 \
  --group-id "$CACHE_SG" \
  --protocol tcp --port 6379 \
  --source-group "$ECS_SG"
```

**Pass:** `/health` stayed 200; no sale row lost; Slack
`warning` then `info` recovery. Capture p95 before/after from
Grafana.

**RTO:** 5 min. **RPO:** 0.

---

## 4. Worker down

**Proves:** daily close is queued. Stopping Commission does not drop
the EventBridge event; it sits on SQS. Replay after restore is a
no-op on `payout_ledger`.

**How to break it**

```bash
aws ecs update-service --region eu-central-1 \
  --cluster devops-g10 \
  --service devops-g10-commission \
  --desired-count 0

# Inject the same shape EventBridge would (do not wait for 20:45 UTC
# on game day):
aws sqs send-message --region eu-central-1 \
  --queue-url "$COMMISSION_CLOSE_URL" \
  --message-body '{"type":"commission.daily-close","reason":"gameday.worker-down"}'

# Watch the DLQ, not the primary, after maxReceiveCount=3:
aws sqs get-queue-attributes --region eu-central-1 \
  --queue-url "$COMMISSION_CLOSE_DLQ_URL" \
  --attribute-names ApproximateNumberOfMessagesVisible \
  | tee evidence/reliability-operations/game-day/4-worker-down/dlq.json
```

**Restore**

```bash
aws ecs update-service --region eu-central-1 \
  --cluster devops-g10 \
  --service devops-g10-commission \
  --desired-count 1

# Redrive ONLY after the worker is healthy and you have confirmed
# payout_ledger uniqueness still holds. Read the runbook first.
```

**Pass:** `#dlq-nonempty` fired; after restore, one ledger row per
`(agent_id, period)`, one B2C. `#commission-late-payout` fires only
if restore crossed 06:30 EAT.

**RTO:** 15 min. **RPO:** 0 duplicate payouts.

---

## 5. Bad release

**Owner:** Yordanos. **Proves:** post-deploy smoke on `/version`
catches a wrong SHA / 5xx, ECS circuit breaker rolls back.

**How to break it**

```bash
# Controlled failure: a web (or POS) image whose /version returns
# 500, or whose COMMIT_SHA does not match GITHUB_SHA.
# Push that image to ECR tagged with THIS commit's SHA so the
# pipeline accepts the tag, then let CodePipeline deploy.

# Watch smoke (G2 addition to web-image.yml / CodeBuild):
#   curl -sSf "$API_URL/version"  → must fail the job
# and ECS:
aws ecs describe-services --region eu-central-1 \
  --cluster devops-g10 --services devops-g10-web \
  --query 'services[0].{events:events[0:5],deployments:deployments}'

# Manual rollback if smoke failed but circuit breaker did not:
PREV=$(aws ecs list-task-definitions --region eu-central-1 \
  --family-prefix devops-g10-web --sort DESC \
  --query 'taskDefinitionArns[1]' --output text)
aws ecs update-service --region eu-central-1 \
  --cluster devops-g10 --service devops-g10-web \
  --task-definition "$PREV"
```

**Pass:** smoke failed closed; previous task def is what `/version`
reports; `#alb-5xx` recovered. Screenshot the pipeline stage.

**RTO:** 10 min. **RPO:** 0.

---

## 6. RDS restore

**Owner:** Yordanos. **Proves:** PITR to a **new** instance. Never
overwrite `devops-g10-pg`. Deletion protection stays on.

**How to break it**

```bash
# Record the break time (RPO clock). Then "lose" a known sandbox row
# via a one-off task using the master secret — do not drop the
# database, do not disable deletion_protection.
BREAK_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$BREAK_AT" > evidence/reliability-operations/game-day/6-rds-restore/break-at.txt

# Example (sandbox only): DELETE a single sale you just created for
# this drill, then restore to 30s before BREAK_AT.
```

**Restore** (new instance, then cut apps over — or just prove the
row is back and destroy the restore instance)

```bash
RESTORE_ID="devops-g10-pg-gameday-$(date -u +%Y%m%d%H%M)"
aws rds restore-db-instance-to-point-in-time --region eu-central-1 \
  --source-db-instance-identifier devops-g10-pg \
  --target-db-instance-identifier "$RESTORE_ID" \
  --restore-time "$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)" \
  --db-instance-class db.t4g.micro \
  --db-subnet-group-name "$(aws rds describe-db-instances \
      --region eu-central-1 \
      --db-instance-identifier devops-g10-pg \
      --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' \
      --output text)" \
  --no-publicly-accessible \
  --no-multi-az \
  --tags Key=capstone,Value=tillflow Key=gameday,Value=rds-restore

aws rds wait db-instance-available --region eu-central-1 \
  --db-instance-identifier "$RESTORE_ID"

# Query the restored instance (from a task in ecs-tasks SG) for the
# deleted row. Then destroy the restore instance — it is not in
# Terraform, so it must not survive G5 cleanup:
aws rds delete-db-instance --region eu-central-1 \
  --db-instance-identifier "$RESTORE_ID" \
  --skip-final-snapshot
```

On macOS `date -v-1M` is "one minute ago"; on Amazon Linux use
`date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ`. Pick a restore time
**before** `BREAK_AT` and after the sale was committed.

**Pass:** the sandbox row is present on `$RESTORE_ID`; prod
`devops-g10-pg` was never modified by the restore API; time-to-available
≤ 30 min. Write actual RTO/RPO next to the targets.

**RTO:** 30 min. **RPO:** ≤ 5 min (PITR). Retention is 7 days —
anything older is out of RPO (ADR-003).

---

## Capture template

For each drill, a `notes.md` in the evidence folder:

```
drill:
started_at_eat:
first_safe_action_at_eat:
restored_at_eat:
rto_measured:
rto_target:
rpo_measured:
rpo_target:
slo_budget_burned:
slack_fired: yes/no
pass: yes/no
exception:   # blank or written rationale
```

## Related

- [runbook.md](runbook.md)
- [alerts.md](alerts.md)
- [ADR-002](adrs/ADR-002-idempotency-and-replay-safety.md)
- [ADR-003](adrs/ADR-003-platform-data-services.md)
- [ADR-004](adrs/ADR-004-cicd-and-golden-path.md)
