#!/usr/bin/env bash
# Capture G2 platform evidence from the live account. Run from repo root:
#   export AWS_PROFILE=g10-yordanos AWS_REGION=eu-central-1
#   ./evidence/platform-delivery/collect.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/evidence/platform-delivery"
PREFIX=devops-g10
REGION="${AWS_REGION:-eu-central-1}"
API_URL="${API_URL:-https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com}"
SERVICES=(web pos payments commission)

mkdir -p "$OUT"

dump_ecs() {
  local svc="$1"
  aws ecs list-tasks --cluster "$PREFIX" --service-name "${PREFIX}-${svc}" \
    --desired-status RUNNING --region "$REGION" > "$OUT/ecs-${svc}-tasks.json"
  local arn
  arn="$(python3 -c "import json; a=json.load(open('$OUT/ecs-${svc}-tasks.json'))['taskArns']; print(a[0] if a else '')")"
  if [ -z "$arn" ]; then
    echo "WARN: no RUNNING tasks for ${PREFIX}-${svc}" >&2
    echo '{}' > "$OUT/ecs-${svc}-task-detail.json"
    return
  fi
  aws ecs describe-tasks --cluster "$PREFIX" --tasks "$arn" \
    --region "$REGION" > "$OUT/ecs-${svc}-task-detail.json"
}

echo "== smoke (web catch-all) =="
curl -sS "${API_URL}/health"  | tee "$OUT/smoke-health.json"
echo
curl -sS "${API_URL}/ready"   | tee "$OUT/smoke-ready.json"
echo
curl -sS "${API_URL}/version" | tee "$OUT/smoke-version.json"
echo

echo "== smoke (pos path routing) =="
# Unauthenticated GET must hit POS auth (401), not web 501 or ALB 404.
# GET (not POST) so collect never creates a sale.
POS_CODE=$(curl -sS -o "$OUT/smoke-pos.json" -w "%{http_code}" \
  "${API_URL}/sales/00000000-0000-0000-0000-000000000001")
echo "GET /sales/:id -> ${POS_CODE}"
cat "$OUT/smoke-pos.json"; echo
python3 - <<PY
import json, sys
code = int("${POS_CODE}")
body = json.load(open("$OUT/smoke-pos.json"))
if code != 401:
    sys.exit(f"pos smoke expected 401, got {code}")
if body.get("error") != "unauthorized":
    sys.exit(f"pos smoke unexpected body: {body}")
print("pos smoke ok")
PY

echo "== smoke (payments path routing) =="
PAY_CODE=$(curl -sS -o "$OUT/smoke-payments.json" -w "%{http_code}" \
  "${API_URL}/internal/v1/payments/00000000-0000-0000-0000-000000000001")
echo "GET /internal/v1/payments/:id -> ${PAY_CODE}"
cat "$OUT/smoke-payments.json"; echo
python3 - <<PY
import json, sys
code = int("${PAY_CODE}")
body = json.load(open("$OUT/smoke-payments.json"))
if code != 401:
    sys.exit(f"payments smoke expected 401, got {code}")
print("payments smoke ok")
PY

python3 - <<PY > "$OUT/smoke-summary.json"
import json
from datetime import datetime, timezone
summary = {
    "api_url": "$API_URL",
    "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "web": {
        "health": json.load(open("$OUT/smoke-health.json")),
        "ready": json.load(open("$OUT/smoke-ready.json")),
        "version": json.load(open("$OUT/smoke-version.json")),
    },
    "pos": {
        "http": int("${POS_CODE}"),
        "path": "/sales/00000000-0000-0000-0000-000000000001",
        "body": json.load(open("$OUT/smoke-pos.json")),
    },
    "payments": {
        "http": int("${PAY_CODE}"),
        "path": "/internal/v1/payments/00000000-0000-0000-0000-000000000001",
        "body": json.load(open("$OUT/smoke-payments.json")),
    },
}
print(json.dumps(summary, indent=2))
PY

echo "== ecs =="
for svc in "${SERVICES[@]}"; do
  dump_ecs "$svc"
done
# Keep G1 filenames as aliases of the web dump so older README steps still work.
cp "$OUT/ecs-web-tasks.json" "$OUT/ecs-tasks.json"
cp "$OUT/ecs-web-task-detail.json" "$OUT/ecs-task-detail.json"

python3 - <<PY > "$OUT/ecs-containers.txt"
import json, sys
ok = True
for svc in ("web", "pos", "payments", "commission"):
    data = json.load(open(f"$OUT/ecs-{svc}-task-detail.json"))
    tasks = data.get("tasks") or []
    print(f"# {svc}")
    if not tasks:
        print({"error": "no RUNNING tasks"})
        if svc != "commission":
            ok = False
        continue
    for c in tasks[0]["containers"]:
        row = {k: c.get(k) for k in ("name", "lastStatus", "healthStatus", "image")}
        print(row)
        if c.get("name") in ("app", "adot") and c.get("lastStatus") != "RUNNING":
            ok = False
        image = c.get("image") or ""
        if c.get("name") == "app":
            digest_ok = "@sha256:" in image
            placeholder_ok = svc == "commission" and "busybox" in image
            if not digest_ok and not placeholder_ok:
                ok = False
                print({"error": "app image is not digest-pinned"})
        if svc == "commission" and "daraja" in image.lower():
            ok = False
            print({"error": "commission image must not mention daraja"})
    print()
if not ok:
    sys.exit("ecs dump failed golden-path checks (RUNNING + digest)")
print("all services: app+adot RUNNING, app digest-pinned")
PY

echo "== ecr tags (no latest) =="
python3 - <<PY > "$OUT/ecr-tags.json"
import json, subprocess, sys
repos = ["devops-g10/web", "devops-g10/pos", "devops-g10/payments", "devops-g10/commission"]
out = {}
latest = []
for repo in repos:
    try:
        raw = subprocess.check_output([
            "aws", "ecr", "describe-images",
            "--repository-name", repo,
            "--region", "$REGION",
            "--query", "imageDetails[].{tags:imageTags,digest:imageDigest,pushed:imagePushedAt}",
            "--output", "json",
        ], text=True, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as err:
        if repo.endswith("/commission"):
            out[repo] = {"skipped": True, "reason": str(err.output or err)[-400:]}
            continue
        raise
    images = json.loads(raw)
    out[repo] = images
    for img in images:
        tags = img.get("tags") or []
        if "latest" in tags:
            latest.append((repo, img.get("digest")))
if latest:
    print(json.dumps({"error": "latest tag present", "hits": latest, "images": out}, indent=2))
    sys.exit("ECR still has a latest tag")
print(json.dumps({"latest_present": False, "images": out}, indent=2))
PY

echo "== tags =="
aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=capstone,Values=tillflow > "$OUT/tag-audit.json"
python3 - <<'PY' > "$OUT/tag-audit.txt"
import json, collections
data = json.load(open("evidence/platform-delivery/tag-audit.json"))
tags_seen = collections.Counter()
missing = []
for r in data["ResourceTagMappingList"]:
    tags = {t["Key"]: t["Value"] for t in r["Tags"]}
    for req in ["group", "owner", "environment", "service", "managed-by", "capstone"]:
        if req not in tags:
            missing.append((r["ResourceARN"], req))
    for k in tags:
        tags_seen[k] += 1
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
