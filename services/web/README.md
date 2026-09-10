# services/web

TillFlow web / API shell. Owned by Berissa (Product+POS) from G2; land&nbsp;here
at G1 is the platform golden-path proof (Yordanos).

## Endpoints

| Method | Path        | Purpose                                            |
|--------|-------------|----------------------------------------------------|
| GET    | `/health`   | Liveness. 200 with no dependency calls.            |
| GET    | `/ready`    | Readiness. 200 when dependencies are reachable.    |
| GET    | `/version`  | `{ commit, digest, environment, started_at }`.     |
| GET    | `/`         | Hello page (JSON).                                 |
| POST   | `/sales`    | Placeholder — POS proxy lands at G2 (returns 501). |

## Local run

```bash
cd services/web
npm ci
npm start   # listens on :8080
curl -s http://127.0.0.1:8080/health | jq .
```

## Container

Built by `services/web/buildspec.yml` in the `devops-g10-web-build`
CodeBuild project. Runs as UID 10001, read-only rootfs, health probe on
`/health`. See [`docs/adrs/ADR-004-cicd-and-golden-path.md`](../../docs/adrs/ADR-004-cicd-and-golden-path.md).

Tags are commit SHAs. ECS always deploys the immutable digest, never a
floating tag.
