# ADR-001 — AWS region and resource naming convention

- **Status:** Accepted
- **Owner:** Yordanos (Platform + delivery)
- **Date:** 2026-09-09
- **Area:** Platform + delivery

## Context

TillFlow runs on AWS and needs ECS Fargate, RDS PostgreSQL, ElastiCache
(Valkey), SQS, EventBridge, and X-Ray. We need a single primary region
that supports all of these on day one, with stable pricing and mature
general availability, and a shared name prefix so every resource the
group creates is easy to identify, filter in the console, and clean up.

## Decision

- **AWS region:** `eu-central-1` (Frankfurt).
- **Resource name prefix:** `devops-g10-`.

All six required services are GA in `eu-central-1` with stable, well
documented pricing, and it is the closest fully-featured region to the
team. Every AWS resource, IAM role, S3 bucket, log group, and alarm the
group creates from here on uses the `devops-g10-` prefix.

## Alternatives considered

- **`af-south-1` (Cape Town).** Geographically closer to the team, but
  has a narrower service and pricing footprint for parts of our stack
  (notably ElastiCache/Valkey and some observability features), and
  fewer instance types available. Rejected to avoid design constraints
  driven by region gaps.
- **`eu-west-1` (Ireland).** Also fully viable and supports every
  service we need. Rejected in favor of `eu-central-1` because
  Frankfurt has slightly lower typical latency from East Africa and is
  our preferred default going forward; either would have been an
  acceptable choice.

## Consequences

- Terraform, CI, IAM, and application config default to
  `region = eu-central-1`. Anything created outside this region needs
  its own ADR.
- Every resource we create — ECS clusters/services, RDS/ElastiCache,
  SQS queues, EventBridge buses/rules, IAM roles, S3 buckets, log
  groups, CloudWatch alarms — is named with the `devops-g10-` prefix.
  S3 buckets additionally take an account-ID suffix for global
  uniqueness (see `docs/naming.md`).
- Grading, cost tracking, and cleanup scripts can filter on
  `devops-g10-*` and on region `eu-central-1` with no ambiguity.

## Proof

- `docs/naming.md` — worked examples of the prefix applied per
  resource type.
- Terraform under `infra/` sets `region = "eu-central-1"` and a
  `name_prefix = "devops-g10-"` input variable used by every module.
