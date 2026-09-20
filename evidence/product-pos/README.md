# evidence/product-pos — Berissa (Product + POS)

Runtime proof for the POS sale path and commission eligibility.

| File | What it proves |
|---|---|
| `g2-seed.json` | Demo tenant + attendant **2222…** seeded on live RDS |
| `g2-seed-attendant2.json` | Second demo attendant **3333…** (rows read back from RDS after seed) |
| `g2-seed-44444444.json` | Third demo attendant **4444…**, used for the SQS-triggered close evidence |
| `g2-close-eligible-YYYY-MM-DD.json` | Paid sales for an EAT business day appear in `GET /internal/v1/commission/eligible` with `payout_msisdn` and `commission_bps`; unpaid sales excluded |
| `g3-cache-valkey.json` | Public GET /sales/:id twice — Valkey miss then hit (G3 B3) |
| `g3-commission-close-trace.json` | SQS-triggered close with `commission.daily_close` X-Ray trace (G3) |
| `g4-cache-break.json` | G4 — revoke ECS→Valkey SG; fail-open 200s, `pos_cache_requests_total{result=error}` +8 (113s) |
| `g4-dlq-recovery.json` | G4 — poison close → DLQ → `devops-g10-commission-dlq` ALARM + Slack → `start-message-move-task` → OK (241s) |

## Reproduce close eligibility (G2)

After Release is green and `devops-g10-commission` is running:

```bash
# SSO profile g10 — browser login alone is not enough for AWS CLI
aws sso login --profile g10
export AWS_PROFILE=g10

export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
TOKENS=$(aws secretsmanager get-secret-value --secret-id devops-g10/service-tokens --region eu-central-1 --query SecretString --output text)
export PAYMENTS_SERVICE_TOKEN=$(echo "$TOKENS" | jq -r .payments_service_token)
export POS_SERVICE_TOKEN=$(echo "$TOKENS" | jq -r .pos_service_token)
export DARAJA_CALLBACK_SECRET=$(echo "$TOKENS" | jq -r .daraja_callback_secret)
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=22222222-2222-2222-2222-222222222222

cd services/pos && npm run g2:close-seed
```

Writes `g2-close-eligible-<today-EAT>.json` in this folder.

## Seed second demo attendant (for Arsema close)

Attendant **2222…** may already have a payout ledger row for a given EAT
period (unique per `agent_id + period`). Arsema needs **3333…** so her live
close proof does not collide.

```bash
aws sso login --profile g10
export AWS_PROFILE=g10
cd services/pos && npm run g2:seed-attendant2
```

Evidence is built from a **SELECT after INSERT** (not hardcoded). Then tell
Arsema to run close seed with:

```bash
export ATTENDANT_ID=33333333-3333-3333-3333-333333333333
npm run g2:close-seed
```

Do **not** delete existing payout ledger rows for 2222….

## Seeding further attendants

The runner is parameterised, so a fresh agent-period can be created without
editing SQL. **3333…** was already spent on a disbursed payout for 2026-09-19,
so the SQS-triggered close evidence used **4444…**:

```bash
export ATTENDANT_ID=44444444-4444-4444-4444-444444444444
export ATTENDANT_EMAIL=demo3@tillflow.dev
export ATTENDANT_NAME="Demo Attendant 3"
cd services/pos && npm run g2:seed-attendant2
```

Evidence lands in `g2-seed-<first-uuid-block>.json`, so re-seeding one
attendant never overwrites another's proof. Inserts are `ON CONFLICT DO
NOTHING`, so re-running is safe.

A payout ledger row is unique per `agent_id + period`, so **each live close
proof needs an attendant that has no payout for that EAT day** — either a new
attendant or the next business day.

## G3 Valkey cache proof (after first Release)

```bash
export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=22222222-2222-2222-2222-222222222222
node services/pos/scripts/g3-cache-proof.js
```

Optional in-VPC (confirms Valkey key via `CACHE_HOST` on the POS task):

```bash
aws sso login --profile g10 && export AWS_PROFILE=g10
evidence/run-in-vpc.sh pos scripts/g3-cache-proof.js
```

Writes `g3-cache-valkey.json`.

## G3 commission close trace (after first Release)

```bash
aws sso login --profile g10
export AWS_PROFILE=g10 AWS_REGION=eu-central-1

cd services/commission
node scripts/g3-close-trace.js
# optional: BUSINESS_DAY=2026-09-19 node scripts/g3-close-trace.js
```

Writes `g3-commission-close-trace.json` with `trace_id` / `xray_trace_id` for
the `commission.daily_close` root span. Open X-Ray in the console and paste
`xray_trace_id`.

## G4 cache break (live drill)

```bash
aws sso login --profile g10
export AWS_PROFILE=g10 AWS_REGION=eu-central-1
export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
node services/pos/scripts/g4-cache-break.js
```

Revokes `cache_from_ecs` SG rule, proves Postgres fail-open, restores ingress.
Writes `g4-cache-break.json`. Run `terraform apply` in `infra/` afterwards if
rule ids drift.

## G4 commission DLQ recovery (live drill)

```bash
aws sso login --profile g10
export AWS_PROFILE=g10 AWS_REGION=eu-central-1
node services/commission/scripts/g4-dlq-recovery.js
```

Blocks ECS→ALB hairpin, sends poison close message, waits ~15 min (poller
visibility 300s × 3), recovers with `start-message-move-task`. Writes
`g4-dlq-recovery.json`. **Do not** run during other drills or deploys.
