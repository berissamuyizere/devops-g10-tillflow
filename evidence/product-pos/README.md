# evidence/product-pos — Berissa (Product + POS)

Runtime proof for the POS sale path and commission eligibility.

| File | What it proves |
|---|---|
| `g2-seed.json` | Demo tenant + attendant **2222…** seeded on live RDS |
| `g2-seed-attendant2.json` | Second demo attendant **3333…** for Arsema's live close (no collision with 2222… / 2026-09-18 ledger) |
| `g2-close-eligible-YYYY-MM-DD.json` | Paid sales for today's EAT business day appear in `GET /internal/v1/commission/eligible` with `payout_msisdn` and `commission_bps`; unpaid sales excluded |

## Reproduce close eligibility (G2)

After Release is green and `devops-g10-commission` is running:

```bash
# From repo root — fetch tokens (do not paste "…" placeholders from docs)
export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
TOKENS=$(aws secretsmanager get-secret-value --secret-id devops-g10/service-tokens --region eu-central-1 --query SecretString --output text)
export PAYMENTS_SERVICE_TOKEN=$(echo "$TOKENS" | jq -r .payments_service_token)
export POS_SERVICE_TOKEN=$(echo "$TOKENS" | jq -r .pos_service_token)
export DARAJA_CALLBACK_SECRET=$(echo "$TOKENS" | jq -r .daraja_callback_secret)
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=22222222-2222-2222-2222-222222222222

node services/pos/scripts/g2-close-seed.js
```

Writes `g2-close-eligible-<today-EAT>.json` in this folder.

## Seed second demo attendant (for Arsema close)

Agent **2222…** is already closed for **2026-09-18** (ledger in merged evidence).
Arsema needs attendant **3333…** so her live ECS close does not collide on
`(agent_id, EAT period)`.

```bash
# SSO profile g10 (AkiraChix 240462142849) — browser login alone is not enough
aws sso login --profile g10
export AWS_PROFILE=g10
cd services/pos && npm run g2:seed-attendant2
```

Writes `g2-seed-attendant2.json`. Then tell Arsema to run `g2-close-seed` with:

```bash
export ATTENDANT_ID=33333333-3333-3333-3333-333333333333
```

Do **not** delete the existing 2026-09-18 ledger row for 2222….
