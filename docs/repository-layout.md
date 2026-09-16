# Repository layout

```
src/
  api/                 # Fastify native agents API
  browser/
    backend.ts         # BrowserBackend / BrowserSession
    cdp/client.ts      # Shared raw CDP WebSocket client
    chromium/          # Brave/Chrome production backend
    mock/              # In-process fixture backend
    factory.ts
  core/                # AgentActor, registry, events
  page-bridge/         # Injected bridge + host client
  providers/
    fixture-web/       # CI double only
    chatgpt-web/       # chatgpt.com Chat token engine
  protocols/openai/    # Completions/Responses façade
  types/
packages/pifrost/      # thin Pi adapter
scripts/
  chatgpt-login.ts
  e2e/                 # L1 API smoke
test/
  unit/
  integration/
  integration/chromium/  # skip-gated real-browser smoke
state/                 # gitignored profiles, cookies, runtime
```
