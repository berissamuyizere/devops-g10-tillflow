#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/evidence/reliability-operations"
URL="${GRAFANA_URL:-https://punywaxwing1700.grafana.net}"
URL="${URL%/}"
TOKEN="${GRAFANA_SA_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Set GRAFANA_SA_TOKEN (Grafana Cloud service account, Viewer is enough)." >&2
  exit 1
fi

auth=(-H "Authorization: Bearer ${TOKEN}" -H "Accept: application/json")

curl -sS "${auth[@]}" "${URL}/api/search?type=dash-db" \
  | jq '[.[] | {uid, title, folderTitle, url}] | sort_by(.uid)' \
  >"$OUT_DIR/g3-grafana-cloud-dashboards.json"

curl -sS "${auth[@]}" "${URL}/api/datasources" \
  | jq '[.[] | {id, name, type, uid, url, jsonData: (.jsonData | {authType, defaultRegion, assumeRoleArn})}]' \
  >"$OUT_DIR/g3-grafana-cloud-datasources.json"

echo "wrote $OUT_DIR/g3-grafana-cloud-dashboards.json"
jq -r '.[] | "\(.uid)\t\(.title)"' "$OUT_DIR/g3-grafana-cloud-dashboards.json"
echo
echo "wrote $OUT_DIR/g3-grafana-cloud-datasources.json"
jq -r '.[] | "\(.type)\t\(.name)\t\(.jsonData.defaultRegion // "-")"' "$OUT_DIR/g3-grafana-cloud-datasources.json"
echo
echo "Still needed: screenshot → $OUT_DIR/g3-grafana-cloud-overview.png"
echo "  ${URL}/d/tillflow-overview/tillflow-overview?from=now-6h&to=now"
