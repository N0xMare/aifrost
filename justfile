# Aifrost local helpers — run from repo root with serve up where noted.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Delete ALL agents (fixture + chatgpt). Preferred before a clean Pi smoke.
clear-aifrost:
	bash scripts/clear-aifrost.sh

# Create one ChatGPT agent (boots/attaches browser for that account)
create-chatgpt account="acct_main":
	#!/usr/bin/env bash
	URL="${AIFROST_URL:-http://127.0.0.1:8787}"
	AUTH_MODE="${AIFROST_AUTH:-none}"
	TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"
	H=(-H "Accept: application/json" -H "Content-Type: application/json")
	if [[ "$AUTH_MODE" != "none" ]]; then H+=(-H "Authorization: Bearer $TOKEN"); fi
	curl -sS -m 180 "${H[@]}" "$URL/v1/agents" \
	  -d "{\"provider\":\"chatgpt-web\",\"account_id\":\"{{account}}\"}"
	echo

# List active agents
agents:
	bash scripts/list-aifrost-agents.sh

# Show / patch ChatGPT account rate-limit (serve must be up)
ratelimit account="acct_main":
	#!/usr/bin/env bash
	URL="${AIFROST_URL:-http://127.0.0.1:8787}"
	AUTH_MODE="${AIFROST_AUTH:-none}"
	TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"
	H=(-H "Accept: application/json" -H "Content-Type: application/json")
	if [[ "$AUTH_MODE" != "none" ]]; then H+=(-H "Authorization: Bearer $TOKEN"); fi
	curl -sS -m 15 "${H[@]}" "$URL/v1/accounts/{{account}}/rate-limit"
	echo

# Local serve (auth=none, headed Brave)
serve:
	AIFROST_AUTH="${AIFROST_AUTH:-none}" AIFROST_BROWSER="${AIFROST_BROWSER:-auto}" AIFROST_HEADLESS="${AIFROST_HEADLESS:-0}" npx tsx src/cli.ts serve

# L1 API smoke (no Pi). Requires: just serve already running + ChatGPT login on acct_main.
# Verbose artifacts under artifacts/smoke/<timestamp>/
smoke-quick:
	AIFROST_AUTH="${AIFROST_AUTH:-none}" bash scripts/e2e/smoke-quick.sh

# Alias
smoke: smoke-quick
