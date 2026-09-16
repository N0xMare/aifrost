#!/usr/bin/env bash
# Delete all non-deleted Aifrost agents. Server must be running.
set -euo pipefail
URL="${AIFROST_URL:-http://127.0.0.1:8787}"
AUTH_MODE="${AIFROST_AUTH:-none}"
TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"

HDR=(-H "Accept: application/json")
if [[ "$AUTH_MODE" != "none" && "$AUTH_MODE" != "0" && "$AUTH_MODE" != "off" ]]; then
  HDR+=(-H "Authorization: Bearer ${TOKEN}")
fi

if ! curl -sS -m 5 "${HDR[@]}" "$URL/healthz" | grep -q '"ok"'; then
  echo "error: Aifrost not healthy at $URL (is serve running?)" >&2
  exit 1
fi

raw="$(curl -sS -m 30 "${HDR[@]}" "$URL/v1/agents")"
ids="$(printf '%s' "$raw" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for a in d.get("data") or []:
    if a.get("lifecycle") != "deleted" and a.get("id"):
        print(a["id"])
')"

if [[ -z "${ids//[$'\t\r\n ']/}" ]]; then
  echo "clear-aifrost: no agents to delete"
  exit 0
fi

n=0
fail=0
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  code="$(curl -sS -m 15 -o /dev/null -w "%{http_code}" -X DELETE "${HDR[@]}" "$URL/v1/agents/${id}" || true)"
  if [[ "$code" == "204" || "$code" == "200" || "$code" == "404" ]]; then
    echo "  deleted $id ($code)"
    n=$((n + 1))
  else
    echo "  failed $id (HTTP $code)" >&2
    fail=$((fail + 1))
  fi
done <<< "$ids"

echo "clear-aifrost: removed $n agent(s)"
if [[ "$fail" -gt 0 ]]; then
  echo "clear-aifrost: $fail delete(s) failed" >&2
  exit 1
fi
