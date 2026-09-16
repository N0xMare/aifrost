#!/usr/bin/env bash
set -euo pipefail
URL="${AIFROST_URL:-http://127.0.0.1:8787}"
AUTH_MODE="${AIFROST_AUTH:-none}"
TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"
HDR=(-H "Accept: application/json")
if [[ "$AUTH_MODE" != "none" && "$AUTH_MODE" != "0" && "$AUTH_MODE" != "off" ]]; then
  HDR+=(-H "Authorization: Bearer ${TOKEN}")
fi
curl -sS -m 15 "${HDR[@]}" "$URL/v1/agents" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for a in d.get("data") or []:
    if a.get("lifecycle") == "deleted":
        continue
    print(a["id"], a.get("provider"), a.get("account_id"), a.get("lifecycle"), "auth="+str(a.get("auth")))
'
