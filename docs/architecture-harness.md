# Aifrost architecture for coding harnesses

## Stack (one path)

```text
coding harness (Pi, SDKs, curl)
        │
        ▼
thin harness adapter (optional)     e.g. packages/pifrost
        │
        ▼
Aifrost product API
  • OpenAI-shaped Completions/Responses on agent mounts
  • Agents control plane (CRUD, history, settings)
  • Owns statefulness, profiles, capture, tool façade
        │
        ▼
browser / WebUI (chatgpt.com, fixture, …)
```

## Product surface (only these)

| Surface                                               | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /compat/openai/agents/{id}/v1/chat/completions` | **Harness path** — stateful by default; latest user turn continues the agent |
| `POST …/responses`, `GET …/models`                    | Same agent mount                                                             |
| `POST/GET/DELETE /v1/agents` …                        | Control plane — create/list/delete agents, inspect history                   |

There is **no** separate Pi API and **no** user-facing “strict Completions” product mode.

`AIFROST_HISTORY_MODE=strict` is internal/test-only. Default is **stateful**: server history is authoritative; client `messages` may drift.

## Tools

| Kind                                       | Where it runs                                           |
| ------------------------------------------ | ------------------------------------------------------- |
| Harness tools (`bash`, `read`, …)          | **Host** (Pi), when Aifrost returns OpenAI `tool_calls` |
| ChatGPT product tools / “code interpreter” | **Remote** OpenAI environment — not your Mac CWD        |

**Live chatgpt-web (product path):** when the client sends `tools[]`, Aifrost
injects a short tool-use instruction into the WebUI turn. If ChatGPT replies
with `AIFROST_TOOL` blocks, those become OpenAI `tool_calls` for Pi (host
execution). Plain prose stays a normal assistant message. After Pi sends
`[tool_result …]`, ChatGPT continues on those observations.

**Fixture only:** `AIFROST_HARNESS_TOOLS=always` may emit deterministic tool
calls for CI (not for real ChatGPT coding).

## pifrost (thin)

- Register provider + models from `GET /v1/agents`
- Env: `AIFROST_URL`, `AIFROST_AUTH` / token, `AIFROST_MODELS=chatgpt|fixture|all`
- Commands: status, agents, refresh, create, prune, help
- **Does not** own history, reconcile, or browser automation

Default `AIFROST_MODELS=chatgpt` hides Fixture(Echo) stubs from `/model` when any ChatGPT agent exists.

## Not Aifrost’s job

- Replacing Pi’s agent loop
- MCP “developer mode” connectors inside chatgpt.com (a different stack: ChatGPT-UI-as-host)
- Perfect bit-identical cloud Completions on WebUI

## Browser isolation

- Personal Brave is never used.
- **One Aifrost Brave process per `account_id`**; many agents = tabs (capped).
- Sticky by default for the life of `serve`. See `docs/browser-isolation.md`.
- ChatGPT **Projects**: new agent chats default into project `aifrost` (see `docs/chatgpt-projects.md`).

## Related approaches (different stack)

ChatGPT UI → MCP → local workspace tools. Complementary, not a substitute for “Pi baseUrl + model.”
