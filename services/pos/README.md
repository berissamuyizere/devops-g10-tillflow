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
| POST | `/sales/:id/cancel` | owner/attendant | Cancel — **only while `created`** (409 once `awaiting_payment`) |
| GET | `/internal/v1/sales/:id` | Payments | Charge inputs |
| POST | `/internal/v1/sales/:id/awaiting-payment` | Payments | `created` → `awaiting_payment` |
| POST | `/internal/v1/sales/:id/paid` | Payments | `awaiting_payment` → `paid` (same `payment_id` replay; different → 409) |
| GET | `/internal/v1/commission/eligible` | Payments/Commission | Paid sales for an EAT business day only |

Identity headers (scaffold until real auth): `X-Tenant-Id`, `X-User-Id`, `X-Role`.  
Payments: `X-Payments-Token` (= `PAYMENTS_SERVICE_TOKEN`). The env is required — POS fail-closes (`500 misconfigured`) if it is unset. There is no in-process `dev-payments-token` default.

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

## Runtime config (ECS / RDS)

The task resolves its database connection at boot, in this order:

1. **`DATABASE_URL`** — used as-is (local, CI, tests).
2. **`DB_SECRET_ID`** — name/ARN of an AWS Secrets Manager secret read at
   boot (ECS). No DB credentials are baked into the image (ADR-003).

The secret is JSON, either a ready-made URL or connection parts:

```json
{ "username": "devops_g10_pos", "password": "…", "host": "…rds.amazonaws.com", "port": 5432, "dbname": "tillflow" }
```

or `{ "url": "postgresql://…" }`. Every connection is pinned to the `pos`
schema via a `search_path` startup option, and TLS is on for secret-sourced
connections (set `"ssl": false` or `DB_SSL=false` to opt out).

**Env the ECS task needs (for Yordanos to wire):**

| Var | Value |
|---|---|
| `DB_SECRET_ID` | `devops-g10/db/pos` |
| `AWS_REGION` | `eu-central-1` |
| `PAYMENTS_SERVICE_TOKEN` | from `devops-g10/…` (service token) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` (ADOT sidecar) |

The one-off migrate job runs the same resolver: `node bin/migrate.js up`
with `DB_SECRET_ID` set (schema + role bootstrap per ADR-003 is Platform's).

## G2 close — seed paid sales + prove eligible (Berissa)

After Release is green (`develop` → `main`), seed paid sales for today's
Africa/Nairobi business day and capture commission eligibility evidence:

```bash
export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
export PAYMENTS_SERVICE_TOKEN=…   # from devops-g10/service-tokens
export POS_SERVICE_TOKEN=…
export DARAJA_CALLBACK_SECRET=…   # from devops-g10/daraja
export TENANT_ID=11111111-1111-1111-1111-111111111111
export ATTENDANT_ID=22222222-2222-2222-2222-222222222222

npm run g2:close-seed
```

Creates one **paid** sale (fake STK) + one **unpaid** control sale, calls
`GET /internal/v1/commission/eligible`, and writes
`evidence/product-pos/g2-close-eligible-<YYYY-MM-DD>.json`.

## Invariants covered in CI

1. Same `Idempotency-Key` + same body → one sale row  
2. Same key + different body → 409  
3. Missing key → 400  
4. Cross-tenant `GET /sales/:id` → 404  
5. Unpaid sales never appear in commission eligibility  
6. Only Payments token can move status to `awaiting_payment` / `paid`  
7. Attendant cancel is allowed only from `created`; 409 once `awaiting_payment`

## Container

Same golden path as `services/web`: non-root uid 10001, OTel bootstrap
(`node --require ./otel-bootstrap.js server.js`), `/health` + `/ready`, and a
commit/digest `/version` for post-deploy smoke. `buildspec.yml` is ready for
the G2 CodeBuild project; deploys the immutable digest, never `latest`.
