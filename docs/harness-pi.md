# Using Aifrost with Pi (earendil-works/pi)

Drive [Pi](https://github.com/earendil-works/pi) as a coding harness against Aifrost:

```text
Pi → pifrost (thin) → Aifrost (stateful OpenAI-shaped + agents API) → ChatGPT Web
```

Architecture: [architecture-harness.md](./architecture-harness.md).

Aifrost exposes an **OpenAI-compatible** Completions surface on **agent mounts** (session = `agt_…`). There is **no Anthropic gateway**. History is **server-owned** (stateful); you do not need perfect client transcript replay.

ChatGPT Web turns are **self-paced per account** so Pi loops cannot stampede chatgpt.com. Defaults are conservative; override with env or `/aifrost ratelimit`. Details: [chatgpt-rate-limits.md](./chatgpt-rate-limits.md).

Two integration tiers:

| Tier  | What you install                         | Best for                                             |
| ----- | ---------------------------------------- | ---------------------------------------------------- |
| **A** | Nothing beyond `~/.pi/agent/models.json` | One or few fixed agents; static config               |
| **B** | **pifrost** package (extension)          | Live agent list, create/refresh, `/aifrost` commands |

---

## 1. Prerequisites

### Aifrost running

From the Aifrost repo root:

```bash
# Local canary without auth (loopback only recommended):
#   export AIFROST_AUTH=none
# Standard API-key style auth (default):
export AIFROST_AUTH=bearer
export AIFROST_AUTH_TOKEN=dev-token-change-me   # use a strong secret outside dev
export AIFROST_BROWSER=auto                    # mock | chromium | brave | auto
export AIFROST_STATE_DIR=./state
# Leave headed for ChatGPT (default). Do NOT set AIFROST_HEADLESS=1 for chatgpt-web.
npm install
npm run dev                                    # listens on 127.0.0.1:8787
```

Confirm:

```bash
curl -s http://127.0.0.1:8787/healthz
# → {"ok":true}
```

### ChatGPT login (once per account)

Live `chatgpt-web` agents need a headed Brave/Chrome profile with a valid ChatGPT session:

```bash
npm run login:chatgpt -- --account acct_main
```

A headed browser opens on `https://chatgpt.com/`. Complete login / Cloudflare / 2FA, wait until the composer is visible, then press Enter in the terminal. Profile data lands under `state/profiles/acct_main/chromium/`.

Cloudflare blocks **headless** Brave even with a good profile. Runtime must stay headed (`AIFROST_HEADLESS` unset or not `1`/`true`).

### Auth

| Mode                 | Env                                                    | Behavior                                                            |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| **none** (local)     | `AIFROST_AUTH=none`                                    | No `Authorization` required. Prefer bind `127.0.0.1` only.          |
| **bearer** (default) | `AIFROST_AUTH=bearer` (or omit) + `AIFROST_AUTH_TOKEN` | Every API call except health needs `Authorization: Bearer <token>`. |

With bearer, Pi must send the same token. Tier A: `models.json` `apiKey: "$AIFROST_AUTH_TOKEN"` + `authHeader: true`. Tier B: export `AIFROST_AUTH_TOKEN` (and optional `AIFROST_AUTH=none` on **both** server and Pi for no-auth).

Default token if bearer and unset: `dev-token-change-me` (logged as a warning).

### Pi

Install and run [Pi coding agent](https://github.com/earendil-works/pi) so that `~/.pi/agent/` exists (settings, models, extensions).

---

## 2. Tier A — `models.json` only (no package)

Point Pi at one agent-scoped OpenAI base URL. Create the agent first (section 3), then put its `agt_…` id into the base URL.

### Full `~/.pi/agent/models.json` example

```json
{
  "providers": {
    "aifrost": {
      "baseUrl": "http://127.0.0.1:8787/compat/openai/agents/agt_XXX/v1",
      "api": "openai-completions",
      "apiKey": "$AIFROST_AUTH_TOKEN",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsUsageInStreaming": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "chatgpt",
          "name": "Aifrost ChatGPT (agt_XXX)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Replace `agt_XXX` with the real agent id from `POST /v1/agents`.

### Field notes

| Field                             | Why                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`                         | Agent-scoped OpenAI mount: `…/compat/openai/agents/{id}/v1`. Pi appends `/chat/completions` (and `/models`).                               |
| `api`                             | Must be `openai-completions`. Do not use Anthropic.                                                                                        |
| `apiKey`                          | `$AIFROST_AUTH_TOKEN` is expanded from the environment. Export it before starting Pi.                                                      |
| `authHeader`                      | `true` so Pi sends `Authorization: Bearer <apiKey>`.                                                                                       |
| `supportsDeveloperRole: false`    | Aifrost accepts `system`/`developer` roles but ChatGPT-class WebUIs are not OpenAI’s developer-role path; keep system prompts as `system`. |
| `supportsUsageInStreaming: false` | Streaming completions do not reliably include OpenAI-style usage chunks.                                                                   |
| `supportsReasoningEffort: false`  | Aifrost does not honor `reasoning_effort` as an OpenAI parameter.                                                                          |

### Environment for Tier A

```bash
export AIFROST_AUTH_TOKEN=dev-token-change-me
# then start pi
```

In Pi, open `/model`, pick the `aifrost` / `chatgpt` entry, and chat as usual.

### Global alias (optional; not needed for Tier A baseUrl)

If a client posts to the unscoped path, Aifrost still requires the agent id:

```http
POST /v1/chat/completions
Authorization: Bearer <token>
Aifrost-Agent-Id: agt_XXX
Content-Type: application/json
```

Agent-scoped mounts are preferred for Pi because the id lives in the base URL.

---

## 3. Create an agent and get the `agt_` id

With Aifrost up and (for ChatGPT) `acct_main` logged in:

```bash
TOKEN="${AIFROST_AUTH_TOKEN:-dev-token-change-me}"
BASE="http://127.0.0.1:8787"

# Live ChatGPT agent
curl -sS "$BASE/v1/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt-web","account_id":"acct_main"}'
```

Response includes `"id":"agt_…"` (and `object: "agent"`). Use that id in `models.json`.

Fixture agent (no browser login; good for dry runs):

```bash
curl -sS "$BASE/v1/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"fixture-web","settings":{"model_or_mode":"fixture-fast"}}'
```

List agents:

```bash
curl -sS "$BASE/v1/agents" -H "Authorization: Bearer $TOKEN"
```

Smoke-test Chat Completions against the agent:

```bash
AGENT_ID=agt_XXX   # paste real id

curl -sS "$BASE/compat/openai/agents/${AGENT_ID}/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": false
  }'
```

Relevant endpoints:

| Method | Path                                             | Notes                                                                     |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `POST` | `/v1/agents`                                     | Create agent; body includes `provider`, optional `account_id`, `settings` |
| `GET`  | `/v1/agents`                                     | List agents                                                               |
| `GET`  | `/v1/agents/{id}`                                | Single agent                                                              |
| `POST` | `/compat/openai/agents/{id}/v1/chat/completions` | OpenAI Chat Completions for that agent                                    |
| `GET`  | `/compat/openai/agents/{id}/v1/models`           | Synthetic model list for the agent                                        |
| `POST` | `/v1/chat/completions`                           | Same as scoped chat; requires `Aifrost-Agent-Id`                          |
| —      | Auth                                             | `Authorization: Bearer <token>` on all of the above                       |

---

## 4. Tier B — **pifrost** package

**pifrost** is the in-repo Pi extension under `packages/pifrost`. It discovers Aifrost agents over the native API and registers them as Pi models so you can pick agents from `/model` without hand-editing base URLs for every `agt_`.

### Install options

**A. Local path via `pi install` (from Aifrost repo root):**

```bash
pi install ./packages/pifrost
```

**B. Copy / symlink into Pi’s global extensions directory:**

```bash
mkdir -p ~/.pi/agent/extensions
cp -R packages/pifrost ~/.pi/agent/extensions/pifrost
# or: ln -s "$(pwd)/packages/pifrost" ~/.pi/agent/extensions/pifrost
```

**C. `settings.json` `packages` entry for a local path**

Global (`~/.pi/agent/settings.json`) or project (`.pi/settings.json`):

```json
{
  "packages": ["/absolute/path/to/aifrost/packages/pifrost"]
}
```

Relative paths in `~/.pi/agent/settings.json` resolve against `~/.pi/agent`; in `.pi/settings.json` they resolve against `.pi`. Absolute paths and `~` are supported. Project packages load after the project is trusted.

Developer details for the package layout and agent→model mapping: [pifrost.md](./pifrost.md).

### Environment

```bash
export AIFROST_URL=http://127.0.0.1:8787
export AIFROST_AUTH_TOKEN=dev-token-change-me
# optional:
# export AIFROST_DEFAULT_AGENT=agt_…
# export AIFROST_API=openai-completions   # or openai-responses
```

| Variable                | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `AIFROST_URL`           | Control-plane origin (no trailing path). Default: `http://127.0.0.1:8787` |
| `AIFROST_AUTH_TOKEN`    | Same bearer token the server was started with                             |
| `AIFROST_DEFAULT_AGENT` | Optional preferred `agt_…` listed first in `/model`                       |
| `AIFROST_API`           | `openai-completions` (default) or `openai-responses`                      |

pifrost calls `GET/POST /v1/agents` and registers OpenAI-compatible models whose base URLs point at  
`{AIFROST_URL}/compat/openai/agents/{agent_id}/v1`.

### Pi UX

1. Start Aifrost, set the env vars, start Pi.
2. Open **`/model`** — Aifrost agents appear as selectable models (refreshed via package logic).
3. **`/aifrost`** command group (when the extension is loaded):

| Command                        | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `/aifrost status`              | Reachability of `AIFROST_URL`, auth, summary of agents              |
| `/aifrost agents`              | List agents from `GET /v1/agents`                                   |
| `/aifrost refresh`             | Re-fetch agents and re-register models for `/model`                 |
| `/aifrost create [account_id]` | Create a `chatgpt-web` agent (default `acct_default`), then refresh |
| `/aifrost help`                | Short help                                                          |

### Browser isolation (personal Brave vs Aifrost)

Aifrost **never** opens your everyday Brave profile. Each agent uses:

```text
{AIFROST_STATE_DIR}/profiles/{account_id}/chromium
```

with its own `--user-data-dir` and CDP port. That is intentional so automation cannot race or crash personal browsing.

While developing Aifrost/pifrost:

1. **Treat Aifrost windows as separate** — headed ChatGPT login/agent windows are not your normal Brave session.
2. **Quit Aifrost when done with live browser work** (stop `npm run dev` / the process) so extra Brave processes exit; leftover headed windows are from Aifrost profiles, not `~/Library/Application Support/BraveSoftware/…`.
3. **After Brave self-updates, fully quit and reopen personal Brave** (⌘Q). Leaving a multi-day session open across an in-place update is a common cause of “Crashed about:blank” (helpers still on the old framework version).
4. **Do not point Aifrost at your default profile** — never set profile paths under `Application Support/BraveSoftware/Brave-Browser`. The launcher refuses those paths.
5. Prefer **fixture-web + `AIFROST_BROWSER=mock`** for automated tests so CI and day-to-day coding do not need a live headed browser.

---

## 5. Semantics you must understand

### Stateful agents, not stateless completions

An Aifrost agent is a **persistent conversation** (SQLite + live browser page). History lives on the **server + WebUI**; the OpenAI `messages` body is a client hint.

### History reconciliation (default: harness-friendly)

**Default is always stateful** for agent mounts (server history is truth; last user message continues the agent if the client transcript drifts). There is no user-facing “strict Completions” product mode.

### Recommended Pi env (live ChatGPT coding) — golden path

**Auth must match on server and Pi.** Mismatch → `HTTP 401` / “Missing bearer token” from pifrost.

```bash
# ── Terminal A: Aifrost (loopback, no auth for solo Mac) ──
cd /path/to/aifrost
export AIFROST_AUTH=none
export AIFROST_BROWSER=auto          # headed Brave/Chrome
export AIFROST_HEADLESS=0
export AIFROST_HOST=127.0.0.1
export AIFROST_STATE_DIR=./state
# sticky multi-tab browser; one process per account_id
# export AIFROST_MAX_TABS_PER_ACCOUNT=10
npx tsx src/cli.ts serve

# once per machine/account:
npm run login:chatgpt -- --account acct_main

# create one clean live agent (or /aifrost create acct_main chatgpt-web in Pi)
curl -sS http://127.0.0.1:8787/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"provider":"chatgpt-web","account_id":"acct_main"}'
```

```bash
# ── Terminal B: Pi ──
export AIFROST_URL=http://127.0.0.1:8787
export AIFROST_AUTH=none             # must match server
export AIFROST_MODELS=chatgpt      # hide Fixture(Echo)
# optional: pin the agent you just created
# export AIFROST_DEFAULT_AGENT=agt_…
pi install /path/to/aifrost/packages/pifrost
pi
# /aifrost status
# /aifrost prune          # drop fixture/failed agents
# /aifrost refresh
# /model → pick ChatGPT · acct_main · agt_…
```

**Bearer alternative:** set `AIFROST_AUTH=bearer` and the **same** `AIFROST_AUTH_TOKEN` in **both** terminals.

**Sanity checks (before coding):**

| Check                                    | Expect                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| `curl -sS http://127.0.0.1:8787/healthz` | `{"ok":true}`                                            |
| pifrost status / list agents             | no 401; ≥1 chatgpt-web agent                             |
| “hello” in Pi                            | prose, no tool                                           |
| “run openssl rand -hex 8 via bash”       | `tool_calls` with that command — **not** `pwd && ls -la` |
| “write a tiny JS chess board”            | prose/code, not forced `ls`                              |

If every non-hello turn is `pwd && ls -la` in &lt;1s: wrong process (old canary), fixture model selected, or serve not restarted after code update. Fix: `/aifrost prune`, pick chatgpt-web agent, restart serve.

### ChatGPT “tools” vs Pi tools

- **ChatGPT Web** product tools run in **OpenAI’s remote sandbox** — not your Mac CWD.
- **Pi tools** run **on your machine** when Aifrost returns OpenAI `tool_calls`.
- Live **chatgpt-web**: model emits `AIFROST_TOOL` blocks → Aifrost → OpenAI `tool_calls` → **Pi executes** → `role:tool` / projected `[tool_result …]` continues the agent. **Not** a hardcoded `ls`.
- MCP / ChatGPT Developer mode is a different stack; not required for Pi.

### Tools: OpenAI façade + harness execution

Client `tools[]` are accepted. Definitions are **stripped** from the WebUI path but **kept** for the tool_calls façade.

| Provider        | Outbound `tool_calls`                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| **fixture-web** | Deterministic CI planner only (`pwd && ls -la` style) — **not** for real coding |
| **chatgpt-web** | Model-driven PE scaffold (`AIFROST_TOOL` → parse → `tool_calls`)                |

Pi runs tools **locally**, then resends `role:tool` results. History projection:

- assistant `tool_calls` (no content) → dropped for history match
- `role: tool` → `[tool_result …]` user text for the next WebUI turn

Full contract: [openai-tools-projection.md](./openai-tools-projection.md). Browser isolation: [browser-isolation.md](./browser-isolation.md).

### Headed Brave / Chromium

Production path is Brave (preferred) or Chrome via CDP, **one profile process per `account_id`**, many agent **tabs** (capped). ChatGPT requires a **headed** window. Expect a real browser UI on the machine running Aifrost — separate from your personal Brave.

### Latency

First turn after create/recover may open/navigate the page; subsequent turns reuse the session. Streaming follows the WebUI’s pace plus CDP/bridge overhead—slower than a direct OpenAI API key, but full agent state is durable.

### Unofficial

This stack automates consumer WebUIs. It is **unofficial**, can break when ChatGPT changes DOM or bot defenses, and is subject to account/ToS risk. Use strong `AIFROST_AUTH_TOKEN`, bind carefully (see Tailscale), and never expose CDP.

---

## 6. Multi-account / multi-agent

- Each ChatGPT login is an **`account_id`** with its own `state/profiles/<account_id>/chromium/` tree.
- Log in once per account:  
  `npm run login:chatgpt -- --account acct_work` (and `acct_personal`, …).
- Create **one agent per conversation** you want isolated:

```bash
curl -sS "$BASE/v1/agents" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt-web","account_id":"acct_work"}'

curl -sS "$BASE/v1/agents" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt-web","account_id":"acct_personal"}'
```

- **Tier A:** one Pi provider (or one model entry) per agent base URL, or multiple providers with different `agt_` paths.
- **Tier B:** `/aifrost create` + `/aifrost refresh`, then pick agents in `/model`.
- Capacity: on a large machine, on the order of **10–20 warm profiles** is a realistic personal budget; all profiles share the host egress IP unless you add per-profile proxies.

The OpenAI `model` field on chat requests is a **label only**—it does **not** retarget the agent’s provider settings. Agent identity is always the path (or `Aifrost-Agent-Id`), not the model string.

---

## 7. Tailscale: remote Pi client

Recommended layout:

1. Run **Aifrost + Brave** on a home/server machine (where headed UI is OK).
2. Bind the API to the Tailscale interface (or `0.0.0.0` only if the host firewall is tight):

```bash
export AIFROST_HOST=0.0.0.0          # or the tailscale0 / 100.x address
export AIFROST_PORT=8787
export AIFROST_AUTH_TOKEN='…strong…'
npm run dev
```

3. On the laptop running Pi, set:

```bash
export AIFROST_URL=http://100.x.y.z:8787    # server’s Tailscale IP
export AIFROST_AUTH_TOKEN='…same strong…'
```

Tier A `baseUrl` becomes:

```text
http://100.x.y.z:8787/compat/openai/agents/agt_XXX/v1
```

Rules of thumb:

- **Client → API** may traverse Tailscale; that is expected.
- **Do not** expose the browser CDP port on the network.
- Prefer Tailscale ACLs + a non-default bearer token over opening `:8787` to the public internet.

---

## 8. Troubleshooting

### `401` unauthorized

- Missing or wrong `Authorization: Bearer …` header.
- Pi `apiKey` / `AIFROST_AUTH_TOKEN` does not match the server’s `AIFROST_AUTH_TOKEN`.
- For Tier A, ensure `authHeader: true` and that `$AIFROST_AUTH_TOKEN` is set in the environment that launches Pi (unresolved env vars leave models unavailable).

### `409` `agent_history_conflict`

- Pi’s `messages` array no longer has the agent’s stored history as an exact prefix (edited earlier turn, compacted history, wrong agent, or client-side rewrite).
- Fix: start a **new agent** for a new thread, or reset client session to match server history (`GET /v1/agents/{id}/history`). Do not force divergent history onto the same agent.

### `auth_expired` / login required

- ChatGPT session cookie died or the page is not authenticated.
- Re-run: `npm run login:chatgpt -- --account <account_id>`.
- Confirm agent `account_id` matches the profile you logged into.
- Generation errors may report `auth_expired` when the page needs login or the composer never became ready.

### Cloudflare / headless failures

- **Symptom:** “Just a moment…”, missing composer, generation fails with page-not-ready style errors.
- **Cause:** headless Chromium/Brave is blocked by ChatGPT’s CF challenge even with a previously good profile.
- **Fix:** do not set `AIFROST_HEADLESS=1` for `chatgpt-web`. Keep headed Brave; complete challenges interactively via `login:chatgpt` when needed.

### Other common issues

| Symptom                          | Check                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Connection refused               | Is `npm run dev` running? Correct host/port / Tailscale IP?                                              |
| Tools / tool messages            | Stripped + projected server-side; tools execute in Pi only — see openai-tools-projection.md              |
| Wrong conversation               | Wrong `agt_` in base URL—list agents and fix models.json / refresh pifrost                               |
| Model field ignored for settings | Expected: `model` is label-only; change agent via new agent or settings API, not the OpenAI model string |

---

## Quick reference: OpenAI paths Pi uses

```text
POST {base}/chat/completions     → /compat/openai/agents/{id}/v1/chat/completions
GET  {base}/models               → /compat/openai/agents/{id}/v1/models
```

with

```text
Authorization: Bearer <AIFROST_AUTH_TOKEN>
```

Native control plane (pifrost / curl):

```text
POST /v1/agents
GET  /v1/agents
POST /v1/chat/completions   + header Aifrost-Agent-Id: agt_…
```

See also: root [README](../README.md), developer notes for [pifrost](./pifrost.md).
