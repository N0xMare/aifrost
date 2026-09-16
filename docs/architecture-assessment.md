# Architecture Assessment (Brave / Chromium)

**Revised:** 2026-09-16 (post live-gate)
**Decision:** Runtime is **Chromium-family, headed** (Brave preferred). Lightpanda/Neo research paths are retired.

## Why headed Chromium for ChatGPT

- Cookies + session tokens in non-Chromium or headless automation contexts hit Cloudflare `Just a moment...`; clearance cookies do not transfer. Headed Brave with a real persistent profile passes.
- Verified live (2026-09): headed Brave on `/snap/bin/brave` completes login, project bootstrap, turns, tool scaffolds, cancel, and recovery.

## Production architecture

```
Aifrost API (Fastify)
  → AgentActor (serialized per-agent queue)
  → ChromiumBrowserBackend (1 process + isolated user-data-dir per account)
  → CDP → page bridge → ProviderWebUIAdapter (chatgpt-web)
  → canonical events → OpenAI Chat Completions (primary) / Responses (best-effort)
```

- One browser process per **account**; each agent gets a page (tab) in that process.
- Profiles live under `state/profiles/<account_id>/chromium` (mode 0700, path-validated account ids).
- The only supported provider is `chatgpt-web` driving chatgpt.com inside the configured ChatGPT Project (default `aifrost`, `AIFROST_CHATGPT_PROJECT`).

## Scale expectations (personal)

This is a personal-scale bridge: one machine, a handful of accounts, headed windows. It is not a headless container farm — Cloudflare actively blocks that shape, and it is out of scope.

## Known-sharp edges

- The WebUI contract is heuristic (DOM + fetch-sniff capture); ChatGPT front-end drift can break selectors — `test/integration/chromium` + a live login are the ground truth.
- Tool calls are prompt-engineered (`AIFROST_TOOL` text protocol), not provider-native function calling.
- No real incremental streaming to clients (single delta at completion); turns can take up to `maxWaitMs`.
