#!/usr/bin/env bash
# Capture G1 evidence from the live account. Run from repo root:
#   export AWS_PROFILE=g10-yordanos AWS_REGION=eu-central-1
#   ./evidence/platform-delivery/collect.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/evidence/platform-delivery"
PREFIX=devops-g10
REGION=eu-central-1
API_URL="${API_URL:-https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com}"

mkdir -p "$OUT"

echo "== smoke =="
curl -sS "${API_URL}/health"  | tee "$OUT/smoke-health.json"
echo
curl -sS "${API_URL}/ready"   | tee "$OUT/smoke-ready.json"
echo
curl -sS "${API_URL}/version" | tee "$OUT/smoke-version.json"
echo

echo "== ecs =="
aws ecs list-tasks --cluster "$PREFIX" --service-name "${PREFIX}-web" \
  --desired-status RUNNING --region "$REGION" > "$OUT/ecs-tasks.json"
TASK_ARN="$(python3 -c 'import json; print(json.load(open("'"$OUT"'/ecs-tasks.json"))["taskArns"][0])')"
aws ecs describe-tasks --cluster "$PREFIX" --tasks "$TASK_ARN" \
  --region "$REGION" > "$OUT/ecs-task-detail.json"
python3 - <<PY > "$OUT/ecs-containers.txt"
import json
data = json.load(open("$OUT/ecs-task-detail.json"))
for c in data["tasks"][0]["containers"]:
    print({k: c.get(k) for k in ("name", "lastStatus", "healthStatus", "image")})
PY

echo "== tags =="
aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=capstone,Values=tillflow > "$OUT/tag-audit.json"
python3 - <<'PY' > "$OUT/tag-audit.txt"
import json, collections
data = json.load(open("evidence/platform-delivery/tag-audit.json"))
tags_seen = collections.Counter()
missing = []
prefix_miss = []
for r in data["ResourceTagMappingList"]:
    tags = {t["Key"]: t["Value"] for t in r["Tags"]}
    for req in ["group", "owner", "environment", "service", "managed-by", "capstone"]:
        if req not in tags:
            missing.append((r["ResourceARN"], req))
    for k in tags:
        tags_seen[k] += 1
    arn = r["ResourceARN"]
    if "devops-g10" not in arn and "s3" not in arn:
        # many ARNs embed the prefix in the name; flag obvious misses
        pass
print("resources tagged capstone=tillflow:", len(data["ResourceTagMappingList"]))
print("tag key coverage:", dict(tags_seen))
if missing:
    print("MISSING REQUIRED TAGS:")
    for arn, req in missing:
        print(f"  {arn}: {req}")
else:
    print("all required tags present")
PY

echo "== outputs =="
if [ -d "$ROOT/infra/.terraform" ]; then
  (cd "$ROOT/infra" && terraform output -json > "$OUT/outputs.json") || true
fi

echo "wrote evidence under $OUT"
