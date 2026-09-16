# Aifrost

Local **API** that turns **chatgpt.com Chat** (headed Brave, project `aifrost`) into a **stateful OpenAI-compatible token engine**.

The intended use is **delegation, not interactive driving**: dispatch a task to a
ChatGPT agent and it works inside ChatGPT's own harness (its models, code
interpreter, browsing, project context) — like a special sub-agent type. Turns
take minutes, not milliseconds; that's expected.

The coding harness (Pi via **pifrost**, or curl) owns the outer agent loop and
retries. Aifrost owns the browser tab, capture, the host-tool façade
(`AIFROST_TOOL` → OpenAI `tool_calls`, for when the sub-agent needs to reach
back to the host), and **per-account rate limits** so chatgpt.com does not
throttle you.

```text
Pi / curl  →  pifrost (optional, thin)
           →  Aifrost  /compat/openai/agents/{agt}/v1/chat/completions
           →  Brave tab  →  ChatGPT Chat  (project “aifrost”)
```

## Status

| Area                                       | Status                                                   |
| ------------------------------------------ | -------------------------------------------------------- |
| Agents API + SQLite                        | Working                                                  |
| Headed Brave, one process per `account_id` | Working (verified live on Brave/Linux)                   |
| Project-scoped ChatGPT chats               | Working (verified live: chats land in project `aifrost`) |
| Completions façade + host `tool_calls`     | Working (verified live: full tool loop round-trips)      |
| `/v1/responses` façade                     | Working, best-effort emulation — see below               |
| User-defined rate limits                   | Working (env, HTTP, `/aifrost ratelimit`)                |
| Cancel / recover / SSE events              | Working (verified live)                                  |
| `pi -p` via pifrost                        | Working (verified live: text + host-tool turns)          |

### API surfaces

- **Native** `/v1/agents/:id/turns` — authoritative; SSE stream of canonical
  generation events.
- **OpenAI Chat Completions** `/compat/openai/agents/{id}/v1/chat/completions` —
  primary compatibility surface; `tools[]` map onto the prompt-engineered
  `AIFROST_TOOL` protocol (one tool call per turn, `tool_choice` ignored).
- **OpenAI Responses** `/compat/openai/agents/{id}/v1/responses` — best-effort
  emulation; `function_call`/`function_call_output` items supported, but
  provider-native features (reasoning items, `previous_response_id`, `store`)
  do not exist on the WebUI.

## Prerequisites

- Node.js **>= 22**
- **Brave** or Chrome/Chromium (headed — Cloudflare blocks headless)
- Optional: `just`, `python3`, `column` (used by helper scripts/Justfile)

## Quick start

```bash
npm install
npm test
export AIFROST_AUTH=none          # loopback only
export AIFROST_BROWSER=auto
just serve                        # 127.0.0.1:8787, headed Brave
```

Log in once per account:

```bash
npm run login:chatgpt -- --account acct_main
```

Create an agent and drive it from Pi:

```bash
just create-chatgpt acct_main     # prints agt_…
export AIFROST_AUTH=none AIFROST_URL=http://127.0.0.1:8787
pi -p --no-session --provider aifrost --model agt_XXX "List all .ts files in src/"
```

Rate limits (recommended defaults: 1 in-flight, 5–10s gap, rolling cap):

```bash
just ratelimit acct_main
# or in Pi: /aifrost ratelimit set acct_main mode=interactive
```

## Docs

| Doc                                                          | Topic                          |
| ------------------------------------------------------------ | ------------------------------ |
| [docs/architecture-harness.md](docs/architecture-harness.md) | Stack lock                     |
| [docs/chatgpt-projects.md](docs/chatgpt-projects.md)         | Project `aifrost` Chat surface |
| [docs/chatgpt-rate-limits.md](docs/chatgpt-rate-limits.md)   | Self-enforced pace             |
| [docs/harness-protocol.md](docs/harness-protocol.md)         | `AIFROST_TOOL` PE              |
| [docs/harness-pi.md](docs/harness-pi.md)                     | Pi / pifrost                   |
| [docs/dev.md](docs/dev.md)                                   | Local dev                      |

## License

Apache-2.0. Browser binaries are system installs (Brave/Chrome terms apply separately).
