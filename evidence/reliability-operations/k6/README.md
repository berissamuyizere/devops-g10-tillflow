# k6 scenarios — reliability evidence

DRI: Saloi. Shared thresholds live in `thresholds.js`.

```
http_req_failed               < 0.01
http_req_duration p(95)       < 500ms
checks                        > 0.99
```

## Target

**Internal ALB DNS**, from inside the VPC. Never API Gateway —
WAF is 200 requests / 5 minutes / source IP
([ADR-004](../../../docs/adrs/ADR-004-cicd-and-golden-path.md)).

```bash
cd infra
ALB=$(terraform output -raw alb_dns_name)
export BASE_URL="http://${ALB}"
```

Yordanos lands a `desired_count = 0` Fargate task
`devops-g10-k6` in the ECS-tasks SG so this does not need a
bastion ([platform-asks-g2.md](../../../docs/platform-asks-g2.md)).

Local substitute (no AWS):

```bash
export BASE_URL=http://127.0.0.1:8080   # services/web
```

## Run

k6 is not an npm dependency. Use the pinned Grafana image:

```bash
K6_IMAGE=grafana/k6:0.54.0
DIR="$(pwd)/evidence/reliability-operations/k6"

docker run --rm -i \
  -e BASE_URL \
  -v "${DIR}:/scripts:ro" \
  "${K6_IMAGE}" run /scripts/smoke.js

docker run --rm -i -e BASE_URL -v "${DIR}:/scripts:ro" \
  "${K6_IMAGE}" run /scripts/baseline.js

docker run --rm -i -e BASE_URL -v "${DIR}:/scripts:ro" \
  "${K6_IMAGE}" run /scripts/spike.js

docker run --rm -i -e BASE_URL -v "${DIR}:/scripts:ro" \
  "${K6_IMAGE}" run /scripts/soak.js
```

From a Fargate task already on the VPC, drop `-v` and copy the
scripts into the image, or mount them from S3
`devops-g10-backups-<acct>`.

## Reports (G3)

Drop HTML/JSON summaries in `reports/` after each real run:

- `reports/smoke-<sha>.json`
- `reports/baseline-<sha>.json`
- `reports/spike-<sha>.json`
- `reports/soak-<sha>.json`

Scripts themselves only hit `/health`, `/ready`, `/version`. They
must not call `POST /sales` or `POST /internal/v1/charges` —
`MPESA_MODE=fake` is required for any future money-path scenario,
and soak/spike must not become a Daraja flood.

## Related

- [docs/slo-error-budgets.md](../../../docs/slo-error-budgets.md)
- [docs/alerts.md](../../../docs/alerts.md)
- [docs/runbook.md](../../../docs/runbook.md)
