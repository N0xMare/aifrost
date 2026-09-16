# Local development

## Serve

```bash
AIFROST_AUTH=none AIFROST_BROWSER=auto AIFROST_HEADLESS=0 just serve
```

Health: `GET /healthz`. Control plane: `/v1/agents`. Token engine: `/compat/openai/agents/{id}/v1/chat/completions`.

ChatGPT **must** stay headed (`AIFROST_HEADLESS=0`). Cloudflare blocks headless.

## Login

```bash
npm run login:chatgpt -- --account acct_main
```

Profiles: `state/profiles/<account_id>/chromium/` (gitignored).

## Tests

```bash
npm test                 # unit + fixture integration (no ChatGPT)
npm run test:pifrost
```

Live L1 (one suite, do not loop): `just smoke-quick` with serve up and ChatGPT logged in.

Live L2: `pi -p --provider aifrost --model agt_…` from the repo root.

## Capture dumps (live debugging)

`AIFROST_CAPTURE_DIR=<dir>` (or `1` → `state/captures/`) writes a capped JSON
dump per generation — raw page-side capture buffer + emitted text + page error.
No cookies/credentials/request bodies. Keeps the newest 20 files per agent.

## Rate limits

Server env `AIFROST_RATE_LIMIT=interactive|agentic|smoke|off`. Per-account PATCH `/v1/accounts/:id/rate-limit`. Every real composer submit is paced and counted (including incomplete-JSON nudges).

## Layout

```
src/api            Fastify
src/browser        Brave/CDP
src/core           AgentActor + account rate limit
src/providers/chatgpt-web
src/protocols/openai
packages/pifrost
scripts/e2e        L1 smoke
```
