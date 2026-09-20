# G3 k6 — public pay path

**Owner:** Saloi. Helper signing: Arsema (`services/payments/scripts/k6/`).

Hits API Gateway only. Never `/internal/*`. Never in-VPC. `MPESA_MODE` stays
fake. Payer is `254700000000`.

**Smoke** (`g3-public-pay.js`) is 1 VU × 3 iterations and fits the standing
WAF **200 req / 5 min / IP**.

**Load** (`g3-load.js`) needs the live WAF limit raised (e.g. 2000) for
the window, then set back to 200. Do not leave the high limit up
overnight. `SCENARIO=full` is smoke + stepped baseline + 30s spike +
**15 min soak**.

```bash
# Timed window only — restore 200 the same evening
python3 evidence/reliability-operations/k6/set-waf-limit.py 2000
# …run k6…
python3 evidence/reliability-operations/k6/set-waf-limit.py 200
```

```bash
export AWS_PROFILE=g10 AWS_REGION=eu-central-1
export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
TOKENS=$(aws secretsmanager get-secret-value \
  --secret-id devops-g10/service-tokens --region eu-central-1 \
  --query SecretString --output text)
export DARAJA_CALLBACK_SECRET=$(echo "$TOKENS" | jq -r .daraja_callback_secret)
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=44444444-4444-4444-4444-444444444444

k6 run evidence/reliability-operations/k6/g3-public-pay.js

# After WAF is 2000 — ~22 min
export SCENARIO=full
k6 run --summary-export evidence/reliability-operations/k6-g3-full.json \
  evidence/reliability-operations/k6/g3-load.js
```
