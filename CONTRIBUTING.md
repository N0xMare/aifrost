# Contributing

## Prerequisites

- Node.js **>= 22** (ESM, built-in `node:test`-adjacent APIs, global `fetch`)
- **Brave** or Chrome/Chromium installed (for `AIFROST_BROWSER=chromium|brave|auto`)
- Optional dev tools used by scripts/Justfile: `just`, `python3`, `column`, `curl`

## Setup

```bash
npm install
npm run build
npm test              # unit + fixture integration; real-browser tests auto-skip
```

## Checks before pushing

```bash
npm run lint          # eslint (flat config)
npm run format:check  # prettier
npm run typecheck:all # src + tests + scripts + packages/pifrost
npm run build
npm test
```

CI runs the same pipeline on every PR (`.github/workflows/ci.yml`).

## Testing model

- **Unit tests** (`test/unit`) pin pure logic: protocol parsing, tool intents,
  rate limiting, persistence, capture cleaning.
- **Fixture integration** (`test/integration`, `MockBrowserBackend` +
  `fixture-web` provider) covers the full API/actor/persistence path without a
  real browser.
- **Chromium smoke** (`test/integration/chromium`) runs only when a real
  Brave/Chrome binary exists — it is `describe.skipIf`-gated and runs headless.
- **Live ChatGPT** validation is manual: `npm run login:chatgpt -- --account X`
  once per account, then create an agent and run a turn. Fake sessions and
  fixtures cannot catch WebUI DOM/SSE drift — treat live runs as the ground
  truth before release.

## Conventions

- TypeScript ESM, strict mode; imports use `.js` suffix (NodeNext).
- Provider-specific logic lives in `src/providers/<id>/`; protocol shaping in
  `src/protocols/`; core lifecycle in `src/core/`.
- Canonical events (`src/types/events.ts`) are protocol-neutral — keep it that
  way; adapt at the edge.
- Tool calls are prompt-engineered (`AIFROST_TOOL` text) — never describe them
  as native function calling, in code or docs.

## Scope

Supported surface: the Aifrost API + its chatgpt.com Chat integration (headed
Brave/Chromium), plus `packages/pifrost` as a usage path. Out of scope: other
providers, headless operation, npm publishing, ChatGPT Work.
