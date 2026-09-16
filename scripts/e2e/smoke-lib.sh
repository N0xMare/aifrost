#!/usr/bin/env bash
# Shared helpers for L1 Aifrost API smoke (no Pi).
# shellcheck disable=SC2034

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AIFROST_URL="${AIFROST_URL:-http://127.0.0.1:8787}"
export AIFROST_AUTH="${AIFROST_AUTH:-none}"
export AIFROST_AUTH_TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"
export AIFROST_SMOKE_ACCOUNT="${AIFROST_SMOKE_ACCOUNT:-acct_main}"
export AIFROST_SMOKE_TIMEOUT="${AIFROST_SMOKE_TIMEOUT:-300}"

ARTIFACT_ROOT="${AIFROST_SMOKE_ARTIFACTS:-$ROOT/artifacts/smoke}"
RUN_ID="${AIFROST_SMOKE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
export ARTIFACT_DIR="${ARTIFACT_DIR:-$ARTIFACT_ROOT/$RUN_ID}"
mkdir -p "$ARTIFACT_DIR"

PASS=0
FAIL=0
SKIP=0
RESULTS_FILE="${ARTIFACT_DIR}/results.tsv"
: >"$RESULTS_FILE"

# Logs go to stderr so command substitutions only capture data (agent ids, etc.)
log() { printf '[smoke] %s\n' "$*" | tee -a "$ARTIFACT_DIR/smoke.log" >&2; }
logv() { printf '[smoke:v] %s\n' "$*" | tee -a "$ARTIFACT_DIR/smoke.log" >&2; }

auth_args() {
  if [[ "${AIFROST_AUTH}" == "none" || "${AIFROST_AUTH}" == "0" || "${AIFROST_AUTH}" == "off" ]]; then
    return 0
  fi
  printf '%s\n' "-H" "Authorization: Bearer ${AIFROST_AUTH_TOKEN}"
}

curl_json() {
  # curl_json METHOD PATH [json-body]
  local method="$1" path="$2" body="${3:-}"
  local url="${AIFROST_URL}${path}"
  local -a args=(-sS -m "${AIFROST_SMOKE_TIMEOUT}" -X "$method"
    -H "Accept: application/json"
    -H "Content-Type: application/json"
    -w "\n%{http_code}")
  while IFS= read -r line; do
    [[ -n "$line" ]] && args+=("$line")
  done < <(auth_args)
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  local raw code json
  set +e
  raw="$(curl "${args[@]}" "$url" 2>"$ARTIFACT_DIR/curl.err")"
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    local err
    err="$(cat "$ARTIFACT_DIR/curl.err" 2>/dev/null || true)"
    printf '%s\n%s\n' "000" "{\"error\":{\"message\":\"curl_failed rc=$rc $err\"}}"
    return 0
  fi
  code="$(printf '%s' "$raw" | tail -n1)"
  json="$(printf '%s' "$raw" | sed '$d')"
  if [[ -z "${json//[$' \t\r\n']/}" ]]; then
    json="{\"error\":{\"message\":\"empty_body HTTP $code\"}}"
  fi
  printf '%s\n%s\n' "$code" "$json"
}

wait_agent_idle() {
  local agent="$1" max_s="${2:-120}"
  local i life act
  for ((i = 0; i < max_s; i++)); do
    local out code body
    out="$(curl_json GET "/v1/agents/${agent}")"
    code="$(printf '%s' "$out" | head -n1)"
    body="$(printf '%s' "$out" | tail -n +2)"
    act="$(printf '%s' "$body" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print(d.get("activity") or "")
except Exception:
 print("")' 2>/dev/null || true)"
    life="$(printf '%s' "$body" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print(d.get("lifecycle") or "")
except Exception:
 print("")' 2>/dev/null || true)"
    if [[ "$code" == "200" && "$act" == "idle" ]]; then
      logv "agent $agent idle (waited ${i}s lifecycle=$life)"
      return 0
    fi
    sleep 1
  done
  logv "agent $agent not idle after ${max_s}s (last activity=$act)"
  return 1
}

record() {
  local name="$1" status="$2" detail="${3:-}"
  printf '%s\t%s\t%s\n' "$name" "$status" "$detail" >>"$RESULTS_FILE"
  case "$status" in
    PASS) PASS=$((PASS + 1)); log "PASS  $name — $detail" ;;
    FAIL) FAIL=$((FAIL + 1)); log "FAIL  $name — $detail" ;;
    SKIP) SKIP=$((SKIP + 1)); log "SKIP  $name — $detail" ;;
  esac
}

require_health() {
  local out code
  out="$(curl_json GET /healthz)"
  code="$(printf '%s' "$out" | head -n1)"
  local body
  body="$(printf '%s' "$out" | tail -n +2)"
  if [[ "$code" != "200" ]] || ! printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    log "Aifrost unhealthy at $AIFROST_URL (HTTP $code): $body"
    return 1
  fi
  log "healthz ok @ $AIFROST_URL"
}

clear_agents() {
  bash "$ROOT/scripts/clear-aifrost.sh" 2>&1 | tee -a "$ARTIFACT_DIR/smoke.log" >&2
}

create_chatgpt_agent() {
  local out code body
  out="$(curl_json POST /v1/agents "{\"provider\":\"chatgpt-web\",\"account_id\":\"${AIFROST_SMOKE_ACCOUNT}\"}")"
  code="$(printf '%s' "$out" | head -n1)"
  body="$(printf '%s' "$out" | tail -n +2)"
  printf '%s\n' "$body" >"$ARTIFACT_DIR/create-agent.json"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    log "create agent failed HTTP $code: $body"
    return 1
  fi
  local id
  id="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  local life auth url ready
  life="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("lifecycle",""))')"
  auth="$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("auth",""))')"
  url="$(printf '%s' "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("conversation") or {}).get("provider_url") or "")')"
  ready="$(printf '%s' "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("runtime") or {}).get("page_ready"))')"
  log "created agent id=$id lifecycle=$life auth=$auth page_ready=$ready"
  logv "provider_url=$url"
  export SMOKE_AGENT_ID="$id"
  printf '%s' "$id" >"$ARTIFACT_DIR/agent_id.txt"
  printf '%s' "$id"
}

completions() {
  # completions AGENT_ID JSON_BODY → writes body to ARTIFACT, prints full response json to stdout
  local agent="$1" body="$2" label="${3:-completions}"
  local path="/compat/openai/agents/${agent}/v1/chat/completions"
  local out code resp
  out="$(curl_json POST "$path" "$body")"
  code="$(printf '%s' "$out" | head -n1)"
  resp="$(printf '%s' "$out" | tail -n +2)"
  printf '%s\n' "$resp" >"$ARTIFACT_DIR/${label}.json"
  printf '%s\n' "$code" >"$ARTIFACT_DIR/${label}.http"
  if [[ "$code" != "200" ]]; then
    logv "completions HTTP $code body=$resp"
  fi
  if printf '%s' "$resp" | grep -qiE 'rate_limited|requests too quickly|limited access to your conversations'; then
    log "LAYER-A RATE LIMIT — aborting L1 (do not retry smoke until cooldown)"
    printf '%s\n' "$resp" >"$ARTIFACT_DIR/rate-limit.json"
  fi
  printf '%s\n' "$resp"
}

abort_if_rate_limited() {
  local json="$1"
  if printf '%s' "$json" | grep -qiE '"code"[[:space:]]*:[[:space:]]*"rate_limited"|requests too quickly|limited access to your conversations'; then
    record "rate-limit" FAIL "ChatGPT/Aifrost layer-A — stop suite"
    summary || true
    log "L1 aborted: rate limit. Wait several minutes. Do not loop smoke."
    exit 1
  fi
}

# --- JSON helpers (python) ---
py_get() {
  local json="$1" expr="$2"
  printf '%s' "$json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
$expr
"
}

has_tool_calls() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
try:
    msg = d["choices"][0]["message"]
    tc = msg.get("tool_calls") or []
    print("yes" if tc else "no")
except Exception:
    print("no")
'
}

tool_call_command() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
try:
    tc = d["choices"][0]["message"]["tool_calls"][0]
    args = tc["function"]["arguments"]
    if isinstance(args, str):
        args = json.loads(args)
    print(args.get("command") or args.get("path") or json.dumps(args)[:200])
except Exception as e:
    print("")
'
}

tool_call_name() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
try:
    print(d["choices"][0]["message"]["tool_calls"][0]["function"]["name"])
except Exception:
    print("")
'
}

assistant_content() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
try:
    c = d["choices"][0]["message"].get("content")
    print(c if isinstance(c, str) else (c or ""))
except Exception:
    print("")
'
}

finish_reason() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
try:
    print(d["choices"][0].get("finish_reason") or "")
except Exception:
    print("")
'
}

error_message() {
  local json="$1"
  printf '%s' "$json" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print(raw[:300]); raise SystemExit
if isinstance(d, dict):
    err = d.get("error") or d.get("message") or d
    if isinstance(err, dict):
        print(err.get("message") or err.get("code") or json.dumps(err)[:300])
    else:
        print(str(err)[:300])
else:
    print(str(d)[:300])
'
}

BASH_TOOL='{"type":"function","function":{"name":"bash","description":"run shell on host","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}'
WRITE_TOOL='{"type":"function","function":{"name":"write","description":"write file on host","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}'
READ_TOOL='{"type":"function","function":{"name":"read","description":"read file on host","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}'

summary() {
  log "---- summary PASS=$PASS FAIL=$FAIL SKIP=$SKIP artifacts=$ARTIFACT_DIR ----"
  if [[ -f "$RESULTS_FILE" ]]; then
    column -t -s $'\t' "$RESULTS_FILE" 2>/dev/null || cat "$RESULTS_FILE"
  fi
  python3 - <<PY | tee "$ARTIFACT_DIR/report.md"
from pathlib import Path
p = Path("$RESULTS_FILE")
rows = [ln.strip().split("\t", 2) for ln in p.read_text().splitlines() if ln.strip()]
print("# Aifrost L1 smoke report")
print()
print(f"- run: \`$RUN_ID\`")
print(f"- url: \`$AIFROST_URL\`")
print(f"- pass: **$PASS**  fail: **$FAIL**  skip: **$SKIP**")
print()
print("| Case | Status | Detail |")
print("|------|--------|--------|")
for r in rows:
    name, st, det = (r + ["",""])[:3]
    det = det.replace("|", "\\\\|")
    print(f"| {name} | {st} | {det} |")
print()
if int("$FAIL") == 0:
    print("**L1 result: READY for Layer 2 (Pi print smoke).**")
else:
    print("**L1 result: NOT ready for Layer 2 — fix failures first.**")
PY
  [[ "$FAIL" -eq 0 ]]
}
