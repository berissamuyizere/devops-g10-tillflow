# services/commission

TillFlow Commission **close worker** (DRI: Berissa — see `CODEOWNERS`).
Platform wiring (ECS/SQS/EventBridge): Yordanos.

**Commission never calls Daraja.** It long-polls SQS
`devops-g10-commission-close` (EventBridge 23:45 EAT → **01:00 EAT** after
platform resubmission), asks POS who is eligible for the **previous EAT
business day**, and asks Payments to disburse via `POST /internal/v1/payouts`.

No public ALB. Probes are local (`/health` on :8080) for ECS.

## Env

| Var | Notes |
|---|---|
| `SQS_QUEUE_URL` | Close queue. Unset = HTTP-only (tests). |
| `POS_BASE_URL` | Internal ALB |
| `PAYMENTS_BASE_URL` | Internal ALB |
| `PAYMENTS_SERVICE_TOKEN` | POS `GET /internal/v1/commission/eligible` |
| `COMMISSION_SERVICE_TOKEN` | Payments `X-Commission-Token` |
| `COMMISSION_TENANT_IDS` | Comma-separated tenant UUIDs |

No `DARAJA_*`. B2C timeout / result callback live in Payments.
