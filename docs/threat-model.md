# Threat model — TillFlow

**Status:** Accepted 
**Owner (DRI):** Arsema (Payments + integrity)
**Contributors:** Yordanos (platform trust boundaries), Berissa (tenant isolation), Saloi (alerts / recovery)
**Date:** 2026-09-10

This is the G0 threat model. Controls that are not yet built are marked **planned**; money-path rules already decided in ADRs are marked **decided**.

## Trust boundaries

| Boundary | Inside | Outside | Crossing traffic |
|---|---|---|---|
| Browser → edge | Web / API Gateway | Attendant, owner, attacker | HTTPS only |
| Public edge → VPC | ALB, ECS services | Internet | VPC Link; no public ECS tasks |
| App → data | POS / Payments / Commission | RDS, Redis, SQS, S3 | Private subnets, IAM + DB roles |
| App → secrets | Task roles | Secrets Manager | Runtime fetch; never baked into images or Terraform plaintext |
| Payments → Daraja | Payments API only | Safaricom Daraja sandbox | TLS; credentials only in Secrets Manager |
| Callbacks → Payments | Payments callback endpoint | Daraja (or attacker forging callbacks) | Auth / signature / shared secret check **planned**; idempotent handling **decided** |
| CI → AWS | GitHub Actions / CodePipeline via OIDC | GitHub runners | No long-lived access keys in the repo |

Commission has **no** Daraja trust boundary — it may only call the Payments API.

## STRIDE by boundary

### S — Spoofing

| Threat | Impact | Mitigation |
|---|---|---|
| Attacker calls POS/Payments as another tenant user | Cross-tenant sale or payout | Tenant-scoped membership + auth on every request (**decided** in sale ADR). Cross-tenant reads return 404 |
| Forged Daraja callback marks a sale paid | False paid sale → wrong commission | Callback authenticity check (**planned**); payment state machine rejects illegal transitions (**decided** ADR-002) |
| Stolen task role / CI role | Infra or secret access | Least-privilege IAM per service; OIDC for deploy; no `latest` tags (**planned** G1) |

### T — Tampering

| Threat | Impact | Mitigation |
|---|---|---|
| Client changes `total_minor` after create | Under/over charge | Line items + total immutable after insert; Payments charges POS `total_minor` only (**decided**) |
| Replay edits payment or ledger state | Double charge / double pay | Idempotency keys + guarded transitions; ledger unique per agent+period (**decided** ADR-002) |
| Public write to S3 evidence/state | Corrupt audit trail | Block public access, KMS, versioning (**planned** G1) |

### R — Repudiation

| Threat | Impact | Mitigation |
|---|---|---|
| "We never got the callback" / "we paid twice" disputes | Ungradeable money path | Append-only style payment/ledger history; traces with `trace_id`/`span_id`; evidence under `evidence/` (**planned** G2–G3) |
| Unsigned console changes | Undocumented infra | Terraform-only; console changes earn no credit (**policy**) |

### I — Information disclosure

| Threat | Impact | Mitigation |
|---|---|---|
| Daraja secrets or Slack webhook in Git / logs / TF state | Credential leak | Secrets Manager only; scan gates in CI (**planned**); never commit customer MSISDNs to evidence beyond sandbox fakes |
| Cross-tenant list endpoints | Privacy / integrity break | Every POS query scoped by `tenant_id` from membership (**decided**) |
| ALB / app logs with full card-equivalent data | PII in CloudWatch | Log sale ids and amounts, not unnecessary PII; sandbox only |

### D — Denial of service

| Threat | Impact | Mitigation |
|---|---|---|
| Flood STK / sale create | Budget burn, queue backup | Rate limits at API Gateway (**planned**); SQS + DLQ; k6 envelopes and error budgets (Saloi) |
| Cache or worker down | Degraded close / pay | DLQ, alerts with runbook link, game-day drills (**planned** G3–G4) |

### E — Elevation of privilege

| Threat | Impact | Mitigation |
|---|---|---|
| Attendant becomes owner / changes till rates | Fraudulent config | Role on membership; owner cannot `POST /sales`, attendant cannot change till (**decided**) |
| Commission service role can call Daraja | Bypass payout controls | Only Payments task role may use Daraja secrets; Commission role may invoke Payments API only (**decided**) |
| Shared DB superuser from app | Schema bleed | Per-service DB roles, least privilege (**planned** G1 platform ADR) |

## Payment-specific abuse cases

These are in scope for G2 proof (invariant tests + trace). DRI: Arsema.

1. **Duplicate sale submit** — Same `Idempotency-Key` twice → one sale row. Different body → `409`.
2. **STK timeout treated as failure** — Forbidden. Payment stays `pending`; reconcile/query settles. Sale does not cancel on timeout.
3. **Callback replay / reorder** — Second success callback is a no-op; illegal transition rejected and logged; still one charge, one `paid_at`.
4. **Callback for unknown or wrong `sale_id` / amount** — Reject; do not mutate another sale.
5. **Daily-close replay** — Same agent+period ledger key → one ledger row, one B2C.
6. **Commission calls Daraja directly** — Architecture forbid; CI/code review + CODEOWNERS on `services/commission/` (Arsema + Berissa).
7. **Pay out unpaid sales** — Commission eligibility is `status=paid` only.
8. **Tampered amount between POS and Payments** — Payments uses persisted POS `total_minor`, not a client-supplied second amount at callback time.
9. **Sandbox vs real money** — Daraja **3.0 sandbox** only; CI/k6 use deterministic fake adapter — never real customer funds.

## Residual risk (accepted for G0)

| Risk | Owner | Until |
|---|---|---|
| Callback auth mechanism not yet chosen (HMAC vs IP allowlist vs shared secret header) | Arsema | Before G2 payments merge |
| API Gateway rate limits and WAF not provisioned | Yordanos | G1 |
| Formal restore / RPO test not yet run | Saloi | G4 |

## Related docs

- [architecture.md](architecture.md)
- [ADR-002 idempotency](adrs/ADR-002-idempotency-and-replay-safety.md)
- [tenant/sale data model](adr-001-tenant-sale-data-model.md)
- [slo-error-budgets.md](slo-error-budgets.md)
