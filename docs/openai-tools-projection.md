# OpenAI tools strip + message projection

Normative contract for harness-friendly Chat Completions (and Responses param strip) against Aifrost agents.

## Goals

1. Treat Aifrost as an **OpenAI-compatible inference provider** for coding harnesses (Pi, etc.).
2. **Never** rely on the WebUI LLM alone to invent OpenAI wire format — tool_calls are a **protocol façade** produced by code (fixture policy, optional scaffold parse).
3. Keep WebUI input **clean text** derived **only by code**.
4. Keep history reconcile **deterministic** and prefix-safe.
5. Enable harness agent loops: request with `tools[]` → response `tool_calls` → harness runs tools → `role:tool` → final text.

## 1A — Strip (request parameters)

At parse time, Aifrost **removes** (does not 422) these client fields when present and non-empty / set:

| Field                 | Action                     |
| --------------------- | -------------------------- |
| `tools`               | deleted if non-empty array |
| `functions`           | deleted if non-empty array |
| `tool_choice`         | deleted                    |
| `function_call`       | deleted                    |
| `parallel_tool_calls` | deleted                    |

Empty `tools: []` is left as-is.

**Harness tools run in the harness.** They are never executed inside ChatGPT Web.

## 1B — Project (messages array)

Before history reconciliation, each OpenAI message is projected to zero or more comparable turns with roles in `{system, developer, user, assistant}` only.

| Incoming                                                            | Projected                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `user`                                                              | `user`, plain text from content                                                            |
| `system` / `developer`                                              | **dropped** (harness-owned; not in durable agent transcript — avoids multi-turn 409 vs Pi) |
| `assistant` with text content                                       | `assistant` with **content only** (tool_calls ignored for history match)                   |
| `assistant` with only `tool_calls` / `function_call` and no content | **dropped**                                                                                |
| `role: tool` or `role: function`                                    | **`user`** with deterministic block: `[tool_result name=… id=…]` + body                    |
| Image content parts                                                 | still **422** `unsupported_parameter`                                                      |

After per-message projection, **consecutive `[tool_result…]` user messages** are coalesced with `\n\n` (parallel tools). Plain user messages are not joined (last plain user only at submit).

Tool **result** payloads longer than **8 192** characters are truncated. Assistant `tool_calls` are not projected as assistant text.

Projection is **pure and deterministic**.

## Reconcile + submit

1. Project client `messages`.
2. Reconcile against **stored** agent history (default **stateful**: prefix match, else last user continues).
3. Suffix: last plain user, or joined tool observations.
4. WebUI/fixture receives one new turn text.

Stored after a text turn: user + assistant. **Tool-only** turns (`tool_calls` façade) do **not** leave a provisional user row (rolled back until a text completion commits).

## Example (Pi-style tool loop)

```text
Stored:  user "fix bug" | assistant "need file"

Client sends:
  user "fix bug"
  assistant "need file"
  assistant tool_calls read_file   → dropped in projection
  tool result "…"                  → user "[tool_result name=read_file id=…]\n…"
  tools: [...]                     → stripped

Suffix submitted to WebUI: the tool_result user text only.
```

## Responses API

`tools` / related params are **stripped** the same way. Responses `input` is already new-turn oriented; no multi-message tool project on that dialect yet.

## Outbound tool_calls (façade)

| Component               | Behavior                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools[]` on request    | Parsed into `CanonicalGenerationRequest.tools`, then stripped from WebUI path                                                                              |
| `CanonicalToolIntent[]` | Code-owned; on `generation.completed`                                                                                                                      |
| OpenAI encode           | `finish_reason: "tool_calls"` + `message.tool_calls` when intents present                                                                                  |
| History                 | Tool-only turns roll back provisional user (no half-open history)                                                                                          |
| **chatgpt-web**         | Inject compact PE protocol v1 (see [harness-protocol.md](./harness-protocol.md)); parse `AIFROST_TOOL` → OpenAI `tool_calls` for Pi (never hardcoded `ls`) |

### Tool-result continue (critical)

After Pi runs tools and resends `role:tool` messages:

1. Aifrost projects them to `[tool_result …]` **user** text only (does **not** re-paste the original user request — WebUI already has it).
2. Each tool payload is truncated (~8KB) so ChatGPT composer + CDP do not hang.
3. Full WebUI submit is hard-capped (~12KB).
4. If generation fails mid-turn, the provisional user row is dropped so Pi retries do not 400 with `No new messages after history reconciliation`.
5. `fixture-web` emits deterministic tool_calls for CI (`AIFROST_HARNESS_TOOLS=always` default on fixture).
6. After a `[tool_result …]` submit, the WebUI continues with the observation — it may request more tools or answer in prose.

## Non-goals

- Running harness tools inside the browser / ChatGPT product tools as OpenAI tools.
- Perfect token parity with cloud OpenAI (stateful agents, UI latency, scrape fidelity).
- Depending on freeform ChatGPT JSON for protocol correctness.

## Implementation map

| Piece                         | Location                                   |
| ----------------------------- | ------------------------------------------ |
| Strip + project               | `src/protocols/openai/project-messages.ts` |
| Tool intents / fixture plan   | `src/protocols/openai/tool-intents.ts`     |
| Reconcile / suffix            | `src/protocols/openai/shared.ts`           |
| Chat Completions parse/encode | `src/protocols/openai/chat-completions.ts` |
| Fixture generate              | `src/providers/fixture-web/adapter.ts`     |
| Responses strip               | `src/protocols/openai/responses.ts`        |

pifrost does **not** reimplement this; it registers agent-scoped OpenAI base URLs only.
