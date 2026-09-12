# services/_shared

Golden path every backend service extends. Owned by Yordanos (Platform).

## Contents

- `Dockerfile.base` — pinned Alpine + Node.js base image. Non-root user
  `app` (uid 10001), read-only-friendly, `HEALTHCHECK` on `/health`.
  Downstream services `FROM` a tagged build of this base image.
- `otel-bootstrap.js` — Node autoinstrumentation. Requires it before any
  application code so incoming HTTP + outgoing pg/redis calls get spans.
- `alerts/slack-notify.sh` — posts the Slack alert contract from
  [`docs/runbook.md`](../../docs/runbook.md). Pulls the webhook from
  Secrets Manager. Owned in practice by Saloi; lives here so Lambda
  and every service emit the same fields.

## Rules

Every backend service:

1. Uses `Dockerfile.base` (or the same base image tag) as its base.
2. Runs as non-root (uid 10001) with `readOnlyRootFilesystem = true`.
3. Exposes `/health` (liveness — process up) and `/ready`
   (readiness — dependencies reachable), both under 100ms.
4. Emits **JSON logs to stdout**, one object per line, with
   `trace_id` and `span_id` fields when available.
5. Requires `otel-bootstrap.js` before any application code
   (`node --require ./otel-bootstrap.js server.js` or equivalent).
6. Reads secrets from AWS Secrets Manager at boot; never from env
   files, never baked into images.
7. Ships alongside the ADOT sidecar (image + config are provided by
   `infra/`; the service just needs to point OTLP at
   `http://localhost:4318`).

## Base image

Do not push `Dockerfile.base` to ECR as `web` or any service repo. It
is a **build-context base** that individual services extend. CI in each
service builds its own image using this base as `FROM`.

`node:20.17-alpine3.20` is pinned at the digest level below. When you
bump Node, update `Dockerfile.base` AND regenerate the digest.
