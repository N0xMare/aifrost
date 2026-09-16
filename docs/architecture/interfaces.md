# Core interfaces

Authoritative sources are under `src/`.

| Interface                       | Path                        |
| ------------------------------- | --------------------------- |
| BrowserBackend / BrowserSession | `src/browser/backend.ts`    |
| Chromium/Brave implementation   | `src/browser/chromium/`     |
| Mock implementation             | `src/browser/mock/`         |
| Raw CDP client                  | `src/browser/cdp/client.ts` |
| ProviderWebUIAdapter            | `src/providers/contract.ts` |
| InferenceProtocolAdapter        | `src/protocols/contract.ts` |
| AgentActor                      | `src/core/agent-actor.ts`   |
| Canonical types                 | `src/types/*`               |
