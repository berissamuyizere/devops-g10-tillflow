# services/pos

TillFlow POS API. Owned by Berissa (Product + POS).

Implements the tenant / sale model in
[`docs/adr-001-tenant-sale-data-model.md`](../../docs/adr-001-tenant-sale-data-model.md)
and the Payments status contract in
[`docs/contracts/pos-payments-api.md`](../../docs/contracts/pos-payments-api.md).

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| GET | `/health` | probe | Liveness |
| GET | `/ready` | probe | DB reachable |
| GET | `/version` | pipeline | `{ commit, digest, … }` |
| POST | `/sales` | attendant | Create sale (`Idempotency-Key` required) |
| GET | `/sales/:id` | tenant member | Read sale (404 cross-tenant) |
| POST | `/sales/:id/cancel` | owner/attendant | Cancel before paid |
| GET | `/internal/v1/sales/:id` | Payments | Charge inputs |
| POST | `/internal/v1/sales/:id/awaiting-payment` | Payments | `created` → `awaiting_payment` |
| POST | `/internal/v1/sales/:id/paid` | Payments | `awaiting_payment` → `paid` (replay no-op) |
| GET | `/internal/v1/commission/eligible` | Payments/Commission | Paid sales for an EAT business day only |

Identity headers (scaffold until real auth): `X-Tenant-Id`, `X-User-Id`, `X-Role`.  
Payments: `X-Payments-Token` (= `PAYMENTS_SERVICE_TOKEN`).

## Local run

```bash
cd services/pos
docker compose up -d --wait   # or: docker-compose up -d
export DATABASE_URL=postgres://pos:pos@127.0.0.1:5433/tillflow_pos
export PAYMENTS_SERVICE_TOKEN=dev-payments-token
npm ci
npm run migrate
npm test
npm start   # :8080
```

## Invariants covered in CI

1. Same `Idempotency-Key` + same body → one sale row  
2. Same key + different body → 409  
3. Missing key → 400  
4. Cross-tenant `GET /sales/:id` → 404  
5. Unpaid sales never appear in commission eligibility  
6. Only Payments token can move status to `awaiting_payment` / `paid`

## Container

Same golden path as `services/web`: non-root uid 10001, OTel bootstrap, `/health`.
`buildspec.yml` is ready for the G2 CodeBuild project.
