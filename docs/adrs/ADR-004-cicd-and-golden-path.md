# ADR-004 — CI/CD, golden path, and edge security

- **Status:** Accepted
- **Owner:** Yordanos (Platform + delivery)
- **Date:** 2026-09-10
- **Area:** Platform + delivery

## Context

The capstone requires two delivery lanes: GitHub Actions for PR checks
and gated `terraform apply`, and AWS CodePipeline for the ECR → ECS
service releases. It also requires a **golden path** every service
follows (multi-stage Docker, non-root, read-only rootfs, `/health` +
`/ready`, JSON logs, OTel attributes, no `latest` tags), and edge
protection at API Gateway. G1 is the gate that has to prove all of it
runs end-to-end for at least one service.

## Decision

### Delivery lanes

- **GitHub Actions — PR + Terraform.**
  - `pr.yml` on every PR: `terraform fmt -check`, `terraform validate`,
    `tflint`, `trivy config` (IaC scan), `gitleaks` (secret scan), plus
    per-service lint/test wherever a service exists.
  - `terraform-plan.yml` on PR touching `infra/**`: `terraform plan`
    against `develop`, plan artifact uploaded to the PR.
  - `terraform-apply.yml` on push to `main`: `terraform apply` via
    GitHub OIDC into the `devops-g10-ci-deploy` role. Protected
    environment `production` with required reviewer.
- **AWS CodePipeline — ECR → ECS.**
  - Source: CodeStar Connections (GitHub App) to this repo, branch
    `main`. Path filters via CodeBuild's `git-filter-changed`
    behaviour so a `services/payments/**` commit only rebuilds
    payments.
  - Build: CodeBuild builds the image with the commit SHA as the tag,
    pushes to ECR, generates an SBOM (syft), scans with Trivy image,
    fails on fixable HIGH/CRITICAL.
  - Deploy: ECS rolling deploy of the immutable digest (never a
    floating tag). Post-deploy smoke hits `/health` on the ALB.
  - Rollback: CodeDeploy is out of scope for the capstone; rollback
    is `aws ecs update-service --task-definition <previous>` triggered
    manually from the runbook when smoke fails.

One CodePipeline, one stage per service — this ADR provisions the
`web` pipeline; POS/Payments/Commission plug in behind the same
scaffolding at G2.

### Golden path (shared)

Everything in `services/_shared/`:

- **Dockerfile.base** — pinned `node:20.17-alpine3.20@sha256:…` base
  image, non-root `app` user (uid 10001), `USER app`, workdir
  `/app`, `HEALTHCHECK CMD` on `/health`. Downstream Dockerfiles
  `FROM devops-g10/base:<sha>` and only add app code.
- **ECS task definition template** — task and container both
  `readonlyRootFilesystem=true`, `user=10001:10001`, tmpfs on
  `/tmp`, `linuxParameters.initProcessEnabled=true`.
- **ADOT sidecar** — pinned `public.ecr.aws/aws-observability/aws-otel-collector@sha256:…`,
  runs alongside every backend task, reads config from the shared
  parameter store entry `/devops-g10/adot/config`. Apps export OTLP
  to `localhost:4318`. JSON logs carry `trace_id` and `span_id`.
- **Standard endpoints:** `/health` (liveness — process up),
  `/ready` (readiness — dependencies reachable), both under 100ms,
  both excluded from SLI numerators.

### Image + tagging policy

- No `latest`. ECR repos have `imageTagMutability = IMMUTABLE`.
- Every image tag is the 40-char git SHA. The digest is what ECS
  actually deploys; the SHA is a human-readable pointer only.
- ECR enhanced scanning on all four repos. Findings block promotion
  if any fixable HIGH/CRITICAL are present; accepted-risk exceptions
  go in `docs/security-exceptions.md` with owner + expiry.

### Edge (API Gateway + WAF)

Closes the threat-model residual on API Gateway rate limits.

- **API Gateway HTTP API** in front of the ALB via VPC Link. Public
  DNS name is what the demo uses at G5.
- **AWS WAFv2** attached to API Gateway with the AWS-managed
  `CommonRuleSet` + `KnownBadInputs`, and a rate-based rule of
  **200 requests / 5 minutes per source IP** across all routes. This
  is intentionally tight for a capstone demo — it protects k6 from
  accidentally becoming the DoS, and Daraja callbacks come from a
  small set of IPs.
- **Access logs** to `devops-g10-logs` in the standard
  `$context.*` JSON shape, plus `x-amzn-trace-id` propagated to
  downstream services.
- The Payments callback route (`POST /payments/callback`) is exempt
  from the rate-based rule (it has its own callback-auth mechanism
  Arsema chooses at G2 — see [threat model](../threat-model.md)).

### OIDC and IAM

- One GitHub OIDC provider in the account
  (`token.actions.githubusercontent.com`).
- One CI deploy role `devops-g10-ci-deploy`, trusted for
  `repo:berissamuyizere/devops-g10-tillflow:ref:refs/heads/main` and
  `:pull_request` for plan-only. Permissions scoped to the resources
  Terraform manages, not `*`.
- Per-service task roles (`devops-g10-<svc>-task`) and exec roles
  (`devops-g10-<svc>-exec`), least privilege — exec pulls from ECR
  and writes logs, task reads its own Secrets Manager entries only.
- Pipeline role `devops-g10-pipeline`, CodeBuild role
  `devops-g10-codebuild`, both scoped to their own artifacts,
  logs, and ECR repos.

## Alternatives considered

- **CodeDeploy blue/green on ECS.** Cleaner rollback, but doubles the
  ECS-service surface and adds another IAM role and listener rule set
  we would have to defend at G5. Rolling + manual rollback is enough
  for a capstone.
- **Long-lived IAM access keys for GitHub Actions.** Fails the
  security requirement. OIDC is now the default and there is no
  reason to accept the risk.
- **CloudFront in front of ALB.** Doesn't add capstone value; the
  brief targets API Gateway, so that is what we use.
- **Distroless base images.** Would be stricter, but debugging in a
  capstone timeframe is easier on Alpine with a shell. Documented as
  next hardening step.

## Consequences

- Only the CI deploy role can `terraform apply` in the account.
  Console clicks earn no evidence credit — this ADR is the enforcement
  hook.
- Every image is traceable back to a commit and a digest visible in
  ECS. The Grafana dashboard shows both.
- WAF rate limits will bite k6 unless k6 runs against the ALB
  directly (which it does — see Saloi's k6 scenarios).
- If a service does not follow the golden path, its PR fails on IaC
  scan or fails the ECR digest check at deploy time.

## Proof

- `infra/iam.tf`, `infra/pipeline.tf`, `infra/ecs.tf`,
  `infra/api_gateway.tf`, `infra/ecr.tf` — resources described above.
- `services/_shared/Dockerfile.base`, `services/web/Dockerfile`,
  `services/web/server.js` — the golden path applied to `web`.
- `.github/workflows/pr.yml`, `terraform-plan.yml`,
  `terraform-apply.yml`, `web-image.yml` — the CI half.
- G1 evidence: `terraform apply` output, first CodePipeline run
  transcript with commit SHA, ECS task ARN with `web` app + ADOT
  sidecar both `RUNNING`, and a `curl` of `/health` through API
  Gateway.
