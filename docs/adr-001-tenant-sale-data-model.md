# ADR-001: Tenant, roles, and sale data model

**Status:** Proposed
**Owner:** Berissa
**Date:** 2026-09-09
**Area:** Product+POS

## Context

TillFlow is multi-tenant. A tenant owner must configure one M-Pesa till, attendants, commission rates, and tenant-scoped roles. An attendant records a sale as line items whose totals are integer minor units. Duplicate `POST /sales` must not create a second sale. Payments (Arsema) will attach STK/B2C to a sale we already persist; Commission must pay out only from sales we mark `paid`. This ADR locks the POS-owned records and the contract Payments will plug into — not Daraja, not Terraform.

## Decision

POS owns schema `pos` in the shared RDS instance. All money is **integer Kenya Shilling cents** (`minor` = 1/100 KES). No floats. Currency is `KES` for every tenant in this capstone. Business day is `Africa/Nairobi`.

### Tenant

One tenant has exactly one till.

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `name` | text | Required |
| `status` | enum | `active` \| `suspended` |
| `mpesa_till` | text | Business till / shortcode the owner configures. Credentials stay in Payments/Secrets Manager — POS stores the till identifier only |
| `default_commission_bps` | int | 0–10000 (0–100%). Applied when an attendant is created without an override |
| `timezone` | text | Always `Africa/Nairobi` |

### Users and tenant-scoped roles

A login belongs to **one** tenant. Role is on the membership, not on the sale.

| Field | Type | Rules |
|---|---|---|
| `user.id` | UUID | Primary key |
| `user.email` | text | Unique |
| `membership.tenant_id` | UUID | FK tenant |
| `membership.user_id` | UUID | FK user; unique `(tenant_id, user_id)` |
| `membership.role` | enum | `owner` \| `attendant` |

- **owner** — configures till, attendants, rates, and memberships. Cannot `POST /sales`.
- **attendant** — records sales for this tenant only. Cannot change till or rates.

Every POS query is scoped by `tenant_id` taken from the authenticated membership. Cross-tenant reads are a 404, not an empty leak.

### Attendant

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key; same person as `membership.user_id` with role `attendant` |
| `tenant_id` | UUID | FK tenant |
| `display_name` | text | Required |
| `payout_msisdn` | text | Phone Commission will B2C to, stored as digits with country code (e.g. `2547…`) |
| `commission_bps` | int | 0–10000; defaults from tenant then frozen on the attendant so a later tenant-default change does not rewrite history |
| `status` | enum | `active` \| `inactive`. Inactive cannot open sales |

### Sale

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `tenant_id` | UUID | FK tenant; required on every row |
| `attendant_id` | UUID | FK attendant; must belong to the same tenant; must be the caller |
| `idempotency_key` | text | Required on create. Unique `(tenant_id, idempotency_key)` |
| `status` | enum | See state machine below |
| `currency` | char(3) | `KES` |
| `total_minor` | int | Sum of line `line_total_minor`; stored; reject if it does not match |
| `created_at` | timestamptz | Set on insert |
| `paid_at` | timestamptz | Null until Payments confirms; then immutable |

**Line items** (1–N per sale, never empty):

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `sale_id` | UUID | FK sale |
| `description` | text | Required |
| `quantity` | int | ≥ 1 |
| `unit_price_minor` | int | ≥ 0 |
| `line_total_minor` | int | Must equal `quantity * unit_price_minor` |

Line items are immutable after insert. Corrections mean cancel (if not `paid`) and a new sale.

### Sale state machine (POS-owned)

```
created → awaiting_payment → paid
                ↘ cancelled
created → cancelled
```

| Status | Meaning | Who may set it |
|---|---|---|
| `created` | Sale persisted; no payment command yet | POS on `POST /sales` |
| `awaiting_payment` | Payments has accepted a charge for this `sale_id` | POS, only after Payments acknowledges the command |
| `paid` | Money confirmed. **Only status Commission may use** | POS, only after Payments signals success. `paid_at` set once |
| `cancelled` | Voided before pay. Terminal | POS owner/attendant; never from `paid` |

A Daraja **timeout is not a decline**. POS does not move `awaiting_payment` to `cancelled` or `paid` on timeout. That decision stays with Payments (query/reconcile). Replay of a paid signal is a no-op: status stays `paid`, `paid_at` unchanged, totals unchanged.

### Idempotent sale create

`POST /sales` requires header `Idempotency-Key` (non-empty, ≤ 64 chars).

- Same tenant + same key + same body → `200` with the original sale (no new row).
- Same tenant + same key + different body → `409`.
- Missing key → `400`.

This is **sale-creation** idempotency only. STK/B2C/callback idempotency is Payments’ ADR.

### Contract for Payments and Commission

POS is source of truth for: tenant, till identifier, attendant, payout MSISDN, line items, `total_minor`, sale existence.

Payments may:

- read `sale_id`, `tenant_id`, `mpesa_till`, `total_minor`, `status`
- tell POS “command accepted” (`created` → `awaiting_payment`) and “paid” (`awaiting_payment` → `paid`)

Payments may **not**: insert sales, change line items or `total_minor`, call Commission, or treat timeout as `cancelled`.

Commission may **not**: read unpaid sales as eligible. Eligibility is `status = paid` AND `paid_at` in the EAT business day being closed. Payout MSISDN and `commission_bps` come from the attendant row as it is at close time (rate is already frozen on the attendant). B2C goes through Payments, never Daraja from Commission.

## Alternatives considered

- **One combined sale+payment table** — rejected. Brief splits POS and Payments; a timeout-is-not-a-decline state would leak Daraja into the sale row.
- **Many tills per tenant** — rejected for this capstone. Brief says the owner configures *the* till; one till keeps STK routing obvious.
- **Money as decimal/float** — rejected. Brief requires integer minor units; floats fail idempotency and commission math.
- **Role as a global flag on the user** — rejected. Roles are tenant-scoped; a global flag cannot express “owner in tenant A”.
- **Commission rate only on the tenant** — rejected. Rates differ per attendant; storing bps on the attendant freezes what daily close will use.

## Consequences

Every sale already has a tenant, an amount, and an id Payments can charge against. Duplicate creates are blocked by the unique `(tenant_id, idempotency_key)` pair. Daily close only needs `status = paid`.

The cost is that Payments cannot write sale rows — they have to go through the status contract. Cancel after `paid` is not allowed, so refunds are out of scope.

To prove this later: this ADR, the e2e sale demo, and tests that (1) the same idempotency key does not insert twice, (2) another tenant cannot read the sale, (3) unpaid sales are not commission-eligible.

## Proof

- ADR: this file (`docs/adr-001-tenant-sale-data-model.md`)
- Implementation / demo: link the POS PR and e2e sale evidence here once they exist (`evidence/product-pos/`)
