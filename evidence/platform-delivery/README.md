# evidence/platform-delivery — G1 reproduction

DRI: Yordanos.

## What G1 proves

- Terraform-managed platform in `eu-central-1` under the `devops-g10-`
  prefix ([ADR-001](../../docs/adrs/ADR-001-region-and-naming.md)).
- Data services (RDS Postgres, Valkey, S3, SQS, EventBridge)
  ([ADR-003](../../docs/adrs/ADR-003-platform-data-services.md)).
- Golden-path service (`web`) deployed via CodePipeline with the app +
  ADOT sidecar containers both `RUNNING`
  ([ADR-004](../../docs/adrs/ADR-004-cicd-and-golden-path.md)).
- GitHub Actions OIDC → `devops-g10-ci-deploy` role, no long-lived keys.
- Immutable-tag ECR repos, enhanced scanning, no `latest` in any task
  definition.
- Every resource tagged
  `group=g10, owner=yordanos, environment=prod, service=<svc>,
   managed-by=terraform, capstone=tillflow`.

## Reproduction

Everything below is deterministic. Set `PREFIX=devops-g10` and
`REGION=eu-central-1`.

### 1. Bootstrap

```bash
cd infra/bootstrap
terraform init
terraform apply
```

Capture output as `bootstrap-apply.txt`.

### 2. Root apply

```bash
cd ../
terraform init \
  -backend-config="bucket=devops-g10-tfstate-<acct>" \
  -backend-config="dynamodb_table=devops-g10-tflock" \
  -backend-config="region=eu-central-1" \
  -backend-config="key=platform/terraform.tfstate"

terraform plan -out=plan.bin > plan.txt
terraform apply plan.bin > apply.txt
terraform output -json > outputs.json
```

Capture: `plan.txt`, `apply.txt`, `outputs.json`.

### 3. Naming + tag audit

```bash
# All names begin with devops-g10-
aws resourcegroupstaggingapi get-resources \
  --region eu-central-1 \
  --tag-filters Key=capstone,Values=tillflow \
  > tag-audit.json

python3 - <<'PY' > tag-audit.txt
import json, collections
data = json.load(open('tag-audit.json'))
tags_seen = collections.Counter()
missing = []
for r in data['ResourceTagMappingList']:
    tags = {t['Key']: t['Value'] for t in r['Tags']}
    for req in ['group','owner','environment','service','managed-by','capstone']:
        if req not in tags:
            missing.append((r['ResourceARN'], req))
    for k in tags:
        tags_seen[k] += 1
print("resources tagged capstone=tillflow:", len(data['ResourceTagMappingList']))
print("tag key coverage:", dict(tags_seen))
if missing:
    print("MISSING REQUIRED TAGS:")
    for arn, req in missing:
        print(f"  {arn}: {req}")
else:
    print("all required tags present")
PY
```

### 4. ECS task boot with sidecar

```bash
CLUSTER=$(terraform output -raw ecs_cluster)
aws ecs list-tasks --cluster "$CLUSTER" --service-name devops-g10-web \
  --desired-status RUNNING --region eu-central-1 \
  > ecs-tasks.json

TASK_ARN=$(jq -r '.taskArns[0]' ecs-tasks.json)
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --region eu-central-1 > ecs-task-detail.json

jq '.tasks[0].containers[] | {name, lastStatus, image}' ecs-task-detail.json \
  > ecs-containers.txt
# Expect: two containers ("app" and "adot") both lastStatus=RUNNING;
# app image must be an @sha256 digest, not a :latest tag.
```

### 5. Public smoke through API Gateway → ALB

```bash
API_URL=$(terraform output -raw api_gateway_url)
curl -sSf "$API_URL/health"  | tee smoke-health.json
curl -sSf "$API_URL/version" | tee smoke-version.json
```

Expect `/version` to contain the exact commit SHA that CodePipeline just
deployed.

### 6. Pipeline transcript

```bash
aws codepipeline get-pipeline-state --name devops-g10-web \
  --region eu-central-1 > pipeline-state.json

aws codepipeline list-pipeline-executions --pipeline-name devops-g10-web \
  --region eu-central-1 --max-items 5 > pipeline-runs.json
```

## Files to commit here

Once the above commands succeed, drop these artifacts under this
directory:

- `bootstrap-apply.txt`
- `plan.txt`, `apply.txt`, `outputs.json`
- `tag-audit.json`, `tag-audit.txt`
- `ecs-tasks.json`, `ecs-task-detail.json`, `ecs-containers.txt`
- `smoke-health.json`, `smoke-version.json`
- `pipeline-state.json`, `pipeline-runs.json`

Along with:

- `screenshots/` — one Grafana/CloudWatch shot of the ECS service
  showing 2/2 running with two containers (screenshots alone earn no
  credit, but they help the walk-through at G5).

## Rebuild-from-scratch verification (for G5)

Run steps 1–5 in a fresh AWS account. The pipeline should be able to
deploy the same commit SHA end-to-end without any console clicks.
