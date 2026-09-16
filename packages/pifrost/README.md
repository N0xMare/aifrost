# pifrost

Pi extension that registers **Aifrost** as an OpenAI-compatible inference provider.

Each durable Aifrost agent becomes a selectable Pi model. Requests go to:

```text
{AIFROST_URL}/compat/openai/agents/{agent_id}/v1
```

using Chat Completions (default) or Responses, with `Authorization: Bearer` from `AIFROST_AUTH_TOKEN`.

## Install

From the monorepo (local path):

```bash
pi install /absolute/path/to/aifrost/packages/pifrost
# or project-local:
pi install -l ./packages/pifrost
```

Or via settings:

```json
{
  "packages": ["/absolute/path/to/aifrost/packages/pifrost"]
}
```

One-off without install:

```bash
pi -e /path/to/packages/pifrost
```

## Environment

| Variable                | Default                 | Meaning                                                                                 |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `AIFROST_URL`           | `http://127.0.0.1:8787` | Aifrost control-plane base URL                                                          |
| `AIFROST_AUTH`          | `bearer`                | `bearer` or `none` (must match server; `none` = no Authorization)                       |
| `AIFROST_AUTH_TOKEN`    | _(empty)_               | Bearer secret when server uses bearer auth                                              |
| `AIFROST_DEFAULT_AGENT` | —                       | Prefer this `agt_…` id when ordering models                                             |
| `AIFROST_API`           | `openai-completions`    | `openai-completions` or `openai-responses`                                              |
| `AIFROST_MODELS`        | `chatgpt`               | `chatgpt` \| `fixture` \| `all` — default hides Fixture(Echo) when ChatGPT agents exist |

Example:

```bash
export AIFROST_URL=http://127.0.0.1:8787
export AIFROST_AUTH_TOKEN=dev-token-change-me
# optional:
export AIFROST_DEFAULT_AGENT=agt_…
export AIFROST_API=openai-completions
```

Start Aifrost first (`npm run dev` in the aifrost repo) and create at least one agent (or use `/aifrost create` below).

## Models

On load, pifrost:

1. Checks `GET /healthz`
2. Lists `GET /v1/agents`
3. Registers provider id **`aifrost`** with one model per non-deleted agent

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| Model id     | Agent id (`agt_…`)                                |
| Display name | `{provider} / {account_id} ({short id})`          |
| baseUrl      | `{AIFROST_URL}/compat/openai/agents/{id}/v1`      |
| API          | From `AIFROST_API`                                |
| Auth         | `Authorization: Bearer` via `$AIFROST_AUTH_TOKEN` |

Deleted agents are omitted. Ready/degraded agents sort before failed. `AIFROST_DEFAULT_AGENT` is listed first when present.

Select a model in Pi (`/model` or your usual model UI) under provider **Aifrost**.

## Commands

| Command                                | Action                                                    |
| -------------------------------------- | --------------------------------------------------------- |
| `/aifrost status`                      | Health + agent count                                      |
| `/aifrost agents`                      | List id / provider / account / lifecycle                  |
| `/aifrost refresh`                     | Re-fetch agents and re-register the provider              |
| `/aifrost create [account] [provider]` | Default fixture-web; use `acct_main chatgpt-web` for live |
| `/aifrost prune`                       | Delete fixture/failed agents; keep ChatGPT                |
| `/aifrost help`                        | Short help                                                |

If Aifrost is down at session start, pifrost notifies a warning and registers an empty model list until `/aifrost refresh` succeeds.

## models.json alternative

Without this extension you can point Pi at a single agent manually in `~/.pi/agent/models.json` (or project models file):

```json
{
  "providers": {
    "aifrost-manual": {
      "baseUrl": "http://127.0.0.1:8787/compat/openai/agents/agt_YOUR_ID/v1",
      "apiKey": "$AIFROST_AUTH_TOKEN",
      "api": "openai-completions",
      "models": [
        {
          "id": "agt_YOUR_ID",
          "name": "Aifrost agent",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

pifrost automates multi-agent discovery and refresh.

## Multi-account

Aifrost isolates browser profiles per `account_id`. Create one agent per account:

```bash
/aifrost create acct_main
/aifrost create acct_work
/aifrost agents
```

Each agent appears as its own model. Log in once per account on the Aifrost side (`npm run login:chatgpt -- --account acct_main`).

## Caveats

- **Stateful agents** — History lives in the browser conversation, not only in the HTTP request. Full-history resubmits may conflict with Aifrost’s reconcile rules (e.g. **409** when history does not match). Prefer continuing turns rather than replaying long unrelated transcripts.
- **Headed Brave** — ChatGPT-class WebUIs often need a headed browser (Cloudflare blocks headless). Keep Aifrost headed for live providers.
- **Tools stay in Pi** — Aifrost accepts `tools[]` and may return OpenAI **`tool_calls`**. Live **chatgpt-web** asks the model for structured `AIFROST_TOOL` blocks (parsed to `tool_calls`); **fixture-web** emulates tools for CI only. Pi runs tools locally and sends `role:tool` results. See `docs/openai-tools-projection.md`.
- **Token secret** — Never put `AIFROST_AUTH_TOKEN` in logs or committed config. Prefer env + `$AIFROST_AUTH_TOKEN` interpolation.
- **Empty models** — Missing token, down server, or zero agents → provider registers with an empty model list until fixed + `/aifrost refresh`.

## Development

Unit tests (from aifrost monorepo root):

```bash
npm run test:pifrost
# or
npx vitest run packages/pifrost/test
```

Pure helpers (`config`, `client`, `provider`) have no Pi peer dependency requirement for tests.

## License

Apache-2.0
