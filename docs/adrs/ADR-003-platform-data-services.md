# ADR-003 — Platform data services (RDS, Valkey, S3)

- **Status:** Accepted
- **Owner:** Yordanos (Platform + delivery)
- **Date:** 2026-09-10
- **Area:** Platform + delivery
- **Supersedes:** —

## Context

G1 has to land a real, applyable AWS platform for TillFlow: RDS
PostgreSQL, ElastiCache Valkey, and the four S3 buckets the group
depends on (Terraform state, artifacts, logs, backups/evidence). The
capstone brief calls out the specific decisions this ADR records —
engine version, instance size, Multi-AZ, per-service schemas + roles,
backup window/retention, and per-bucket versioning/KMS/BPA/lifecycle.
Everything defaults to region `eu-central-1` and the `devops-g10-`
prefix from [ADR-001](ADR-001-region-and-naming.md).

## Decision

### RDS PostgreSQL

- **Engine:** PostgreSQL **16.4**. Latest widely-supported minor on
  `eu-central-1`, matches what the app libraries target.
- **Instance class:** `db.t4g.micro` for the capstone. Cheap, ARM,
  fits every workload we will run at k6 sustained RPS.
- **Storage:** `gp3`, 20 GiB, autoscale to 50 GiB. No provisioned IOPS.
- **Multi-AZ:** **Single-AZ** for the capstone. Rationale: cost. RPO
  is met by automated snapshots and PITR; Multi-AZ is documented as
  the first change we would make in production.
- **Backups:** 7-day retention, backup window `02:00–03:00 UTC`
  (`05:00–06:00 EAT`, before the daily commission close at 06:30 EAT).
  Point-in-time recovery on.
- **Deletion protection:** on. `skip_final_snapshot=false`.
- **Encryption:** KMS with the AWS-managed `aws/rds` key (cheap and
  sufficient; a customer-managed key would be the next hardening step).
- **Network:** Private subnets only, SG allows 5432 from ECS task SG
  only.
- **Per-service schemas + roles:** the DB is created with a single
  master user Terraform uses only to bootstrap. Each service gets its
  own PostgreSQL **schema** (`pos`, `payments`, `commission`) and a
  **role** (`devops_g10_pos`, `devops_g10_payments`,
  `devops_g10_commission`) that only has `USAGE`, `CREATE`,
  `SELECT/INSERT/UPDATE/DELETE` on its own schema. Application
  credentials for each role live in Secrets Manager (`devops-g10/db/*`)
  and are read at runtime by the task role. Bootstrapping of the roles
  themselves is done by a one-off migration container in G2, not by
  Terraform, so the master credential does not need to leave the
  cluster.
- **Connection pooling:** in-process pool per service task (pgBouncer
  is out of scope for the capstone unless k6 shows a wall).

### ElastiCache Valkey (Redis-compatible)

- **Engine:** Valkey 7.2 (Redis-compatible). Cheaper than Redis OSS on
  ElastiCache and API-compatible with our cache-aside patterns.
- **Node type:** `cache.t4g.micro`, one primary, no replica (capstone
  cost). Encryption in transit + at rest. AUTH token in Secrets
  Manager (`devops-g10/cache/auth`).
- **Network:** Private subnets, SG allows 6379 from ECS task SG only.

### S3 buckets

One bucket per purpose. All buckets are `devops-g10-<purpose>` (plus
`-<account_id>` for global uniqueness where needed). Every bucket:

- SSE-KMS with the AWS-managed `aws/s3` key.
- `BlockPublicAccess` all four flags on.
- Versioning on.
- Access logging pointed at `devops-g10-logs` (except the logs bucket
  itself, which does not log to itself).
- Ownership controls: `BucketOwnerEnforced` (no ACLs).

Per-bucket lifecycle:

| Bucket | Purpose | Lifecycle |
|---|---|---|
| `devops-g10-tfstate-<acct>` | Terraform state | Keep noncurrent versions 90 days, no expiration on current. Bootstrap-created (see `infra/bootstrap/`). |
| `devops-g10-artifacts-<acct>` | Pipeline / CodeBuild artifacts | Expire current after 30 days; abort MPUs after 7 days. |
| `devops-g10-logs-<acct>` | ALB access logs, VPC flow logs, other server-side logs | Transition to Glacier IR after 30 days; expire after 90 days. |
| `devops-g10-backups-<acct>` | RDS exports, evidence bundles for G5 | Transition to Glacier IR after 30 days; expire after 365 days. |

The state bucket adds a DynamoDB lock table (`devops-g10-tflock`, PK
`LockID`, PAY_PER_REQUEST) — created together in `infra/bootstrap/`
against a local backend, then the root module migrates state into it.

## Alternatives considered

- **Aurora Serverless v2.** Better for spiky workloads and Multi-AZ
  by default, but ~5–10× the cost for a capstone that will never
  sustain > 50 RPS. Rejected on cost.
- **Redis OSS on ElastiCache.** Same feature surface for our
  cache-aside; Valkey is cheaper and AWS is defaulting to it. Chose
  Valkey.
- **Self-hosted Postgres/Redis on ECS.** Loses point-in-time recovery,
  managed patching, and IAM auth — actively hurts the reliability and
  security score. Rejected.
- **One shared S3 bucket with prefixes.** Simpler up front, but
  different retention/lifecycle per purpose and different blast
  radius. Split is standard practice; the brief explicitly asks for
  it.

## Consequences

- Cost stays inside the capstone budget: RDS `db.t4g.micro` +
  ElastiCache `cache.t4g.micro` + four small S3 buckets is < ~$45/month
  before free tier.
- Restoring RDS uses PITR up to 7 days back. Anything older is out of
  RPO and the runbook says so.
- Because there is no Multi-AZ, an AZ outage takes RDS down for the
  duration of the outage. That is on the [threat model](../threat-model.md)
  residual list and it is the game-day scenario Saloi runs at G4.
- Every application service needs its DB URL and cache URL built from
  Secrets Manager at boot — no envs baked into images, no plaintext in
  Terraform state.
- Log/artifact/backups lifecycle keeps S3 costs bounded without
  losing G5 evidence (backups keep 365 days).

## Proof

- `infra/bootstrap/` — state bucket + Dynamo lock (applyable).
- `infra/rds.tf`, `infra/cache.tf`, `infra/s3.tf` — resources
  described above.
- G1 evidence: `terraform apply` output + `aws rds describe-db-instances`
  + `aws s3api get-bucket-versioning` for each bucket in
  `evidence/platform-delivery/`.
