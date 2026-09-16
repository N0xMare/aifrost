# pifrost — developer notes

**pifrost** is the Pi coding agent extension that surfaces Aifrost agents as selectable models. End-user setup (Tier A vs B, env, troubleshooting) lives in [harness-pi.md](./harness-pi.md). This page is the short map for people changing the package.

## Location

```text
packages/pifrost/
  extensions/     # Pi extension entrypoints (loaded by pi package discovery)
  test/           # package tests
```

Install from the Aifrost monorepo root, e.g. `pi install ./packages/pifrost`, copy/symlink under `~/.pi/agent/extensions`, or list the absolute path in Pi `settings.json` → `packages`. See [harness-pi.md](./harness-pi.md#4-tier-b--pifrost-package).

## Runtime configuration

| Env                     | Role                                                      |
| ----------------------- | --------------------------------------------------------- |
| `AIFROST_URL`           | Origin of the control plane, e.g. `http://127.0.0.1:8787` |
| `AIFROST_AUTH_TOKEN`    | Bearer token; must match the server                       |
| `AIFROST_DEFAULT_AGENT` | Optional `agt_…` preferred first in `/model` ordering     |
| `AIFROST_API`           | `openai-completions` (default) or `openai-responses`      |

`/aifrost ratelimit` reads/writes `GET|PATCH /v1/accounts/:id/rate-limit` (server-enforced ChatGPT pace). See [chatgpt-rate-limits.md](./chatgpt-rate-limits.md).

All HTTP calls use:

```http
Authorization: Bearer <AIFROST_AUTH_TOKEN>
```

## Agents → models mapping

pifrost does **not** invent a second protocol. It:

1. Lists agents with **`GET /v1/agents`** (and creates with **`POST /v1/agents`** when `/aifrost create` is used).
2. For each agent id `agt_…`, registers a Pi provider/model whose OpenAI-compatible **`baseUrl`** is:

   ```text
   {AIFROST_URL}/compat/openai/agents/{agent_id}/v1
   ```

3. Configures that model for Pi’s **`openai-completions`** API so chat goes to:

   ```text
   POST …/compat/openai/agents/{agent_id}/v1/chat/completions
   ```

4. Optionally uses the global alias when a single base is preferred:

   ```text
   POST {AIFROST_URL}/v1/chat/completions
   Aifrost-Agent-Id: agt_…
   ```

   Agent-scoped mounts are the default for registered models (agent id in the path).

Identity rules:

- **Agent id** selects conversation + browser session + account profile.
- OpenAI **`model`** string is a **label only** on the Aifrost side (does not rebind the agent).
- History is **stateful**; Chat Completions bodies are prefix-reconciled (conflicts → `409 agent_history_conflict`).
- **No Anthropic gateway** — do not register `anthropic-messages` against Aifrost.
- **Tools** — stripped/projected on the Aifrost server ([openai-tools-projection.md](./openai-tools-projection.md)); pifrost does not alter request bodies.

In-session commands (when the extension loads): `/aifrost status`, `/aifrost agents`, `/aifrost refresh`, `/aifrost create` — see harness doc.

## Test command

From the Aifrost repository root:

```bash
# Whole workspace (includes Aifrost unit/integration + pifrost)
npm test

# pifrost unit tests only
npm run test:pifrost

# bridge contract (fixture-web OpenAI path pifrost uses)
npx vitest run test/integration/pifrost-bridge.test.ts
```

Prefer fixture-backed Aifrost (`AIFROST_BROWSER=mock` / `fixture-web` agents) in automated tests so CI does not need headed Brave or ChatGPT login.

## Related control-plane surface

| Method | Path                                             |
| ------ | ------------------------------------------------ |
| `POST` | `/v1/agents`                                     |
| `GET`  | `/v1/agents`                                     |
| `POST` | `/compat/openai/agents/{id}/v1/chat/completions` |
| `POST` | `/v1/chat/completions` (+ `Aifrost-Agent-Id`)    |

Auth: `Authorization: Bearer …` on all of the above.
