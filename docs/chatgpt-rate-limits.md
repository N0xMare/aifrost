# ChatGPT Web rate limits (Aifrost self-enforced protocol)

Aifrost treats each ChatGPT **account** as a single polite human client. OpenAI
does not publish a stable chatgpt.com automation RPM; this protocol is
**self-enforced** so Pi/pifrost users do not stampede the WebUI.

ChatGPT **Work** is out of scope (deferred). Agents stay on **Chat + Project
`aifrost`**. See [chatgpt-projects.md](./chatgpt-projects.md).

## Layers (do not conflate)

| Layer                     | Typical signal                                                                                                             | Recovery                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **A** Conversation-access | Banner _“You’re making requests too quickly… limited access to your conversations”_; HTTP 429 on conversation/history APIs | Minutes (Aifrost **cools the account**)     |
| **B** Plan / model quota  | Model fallback, usage-limit copy, hours-long lock                                                                          | Hours; surface to user, do not spin retries |
| **C** Concurrent sessions | Overlapping gens / many tabs / extra clients                                                                               | One in-flight generate per account          |

Layer **A** is what L1 smoke hit. It is often a **history/conversation API**
throttle (even sidebar load can contribute), not “typing cadence.”

## Rules (R0–R8)

| Id     | Rule                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **R0** | Pace by **`account_id`**, not agent id. All agents on one account share one gate.                                                          |
| **R1** | Default **max 1 in-flight** WebUI generation per account. Others **wait** (gap + previous end), they do not start a second ChatGPT stream. |
| **R2** | After a stream **ends**, wait **min submit gap** (mode preset) before the next submit.                                                     |
| **R3** | Every WebUI submit counts — including host-only / incomplete-tool **correctives**.                                                         |
| **R4** | Prefer **reuse** a warm agent. Creating/listing/deleting many chats fills layer A.                                                         |
| **R5** | On layer A/B detect: **fail retryable**, start **cooldown**, never tight-loop.                                                             |
| **R6** | Keep PE compact (token + abuse heat). Separate from this scheduler.                                                                        |
| **R7** | Humanize (typing jitter) is optional polish, **not** this protocol.                                                                        |
| **R8** | Smoke uses `mode=smoke`, inter-case gaps, **abort the suite** on layer A.                                                                  |

## Mode presets (recommended defaults)

| Mode                                | Min gap after stream end | Rolling max submits | Typical use               |
| ----------------------------------- | ------------------------ | ------------------- | ------------------------- |
| `interactive`                       | 5s                       | 30 / 15 min         | Human + Pi chat           |
| `agentic` (default for chatgpt-web) | 10s                      | 24 / 15 min         | Coding loops              |
| `smoke`                             | 20s                      | 16 / 15 min         | L1 API smoke              |
| `off`                               | —                        | —                   | Disable (tests / fixture) |

Individual fields override the preset. **fixture-web is never gated** (CI).

Cooldown (layer A): start **5 min**, exponential on repeat, cap **30 min**.

These numbers are **policy defaults**, not OpenAI guarantees. The adaptive
contract is: detect 429/banner → lengthen cooldown.

## Config (env — server)

| Variable                           | Default     | Meaning                                               |
| ---------------------------------- | ----------- | ----------------------------------------------------- |
| `AIFROST_RATE_LIMIT`               | `agentic`   | `interactive` \| `agentic` \| `smoke` \| `off` \| `0` |
| `AIFROST_RATE_MIN_SUBMIT_GAP_MS`   | (from mode) | Override min gap                                      |
| `AIFROST_RATE_MAX_INFLIGHT`        | `1`         | Concurrent generations per account                    |
| `AIFROST_RATE_ROLLING_WINDOW_MS`   | `900000`    | 15 minutes                                            |
| `AIFROST_RATE_ROLLING_MAX_SUBMITS` | (from mode) | Max WebUI submits in window                           |
| `AIFROST_RATE_COOLDOWN_MS`         | `300000`    | Initial layer-A cooldown                              |
| `AIFROST_RATE_MAX_COOLDOWN_MS`     | `1800000`   | Cooldown cap                                          |
| `AIFROST_RATE_ACQUIRE_WAIT_MS`     | `600000`    | Max wait for inflight+gap (then 429)                  |

## Per-account overrides (Pi / pifrost)

Persisted in SQLite (`account_rate_limits`). Survive serve restart.

```http
GET  /v1/rate-limit
GET  /v1/accounts/:account_id/rate-limit
PATCH /v1/accounts/:account_id/rate-limit
```

`PATCH` body (all optional):

```json
{
  "enabled": true,
  "mode": "interactive",
  "max_inflight": 1,
  "min_submit_gap_ms": 8000,
  "rolling_window_ms": 900000,
  "rolling_max_submits": 20,
  "cooldown_ms": 300000,
  "max_cooldown_ms": 1800000
}
```

Set `"mode": "off"` or `"enabled": false` to disable for that account.

pifrost:

```text
/aifrost ratelimit
/aifrost ratelimit status acct_main
/aifrost ratelimit set acct_main mode=interactive min_submit_gap_ms=8000
/aifrost ratelimit off acct_main
/aifrost ratelimit defaults
```

## Runtime behavior

1. Before mutating history / submitting to ChatGPT, the actor **acquires** a
   lease for `account_id` (chatgpt-web only).
2. If **cooldown** or **rolling budget** exceeded → HTTP **429**
   `rate_limited` (retryable) with `retry_after_ms` — **no WebUI submit**.
3. If another generate is in flight → **wait** until it ends + min gap
   (up to `acquire_wait_ms`).
4. **Every** composer send (primary, incomplete-JSON nudge, host-only corrective)
   is paced (`min_submit_gap_ms`) and counted toward the rolling window.
5. Adapter/actor scan for layer-A banner / `rate_limited` → **noteLimited**
   (starts cooldown).

Pi sees a normal OpenAI-shaped 429 and should stop or wait `retry_after_ms`.

## Smoke

`just smoke-quick` should set `AIFROST_RATE_LIMIT=smoke` on the **server**
(or PATCH the smoke account). The suite **aborts** if a completion returns
`rate_limited` or the “requests too quickly” banner text.

Do **not** loop smoke after a layer-A hit. Cool down first.

## Code

- `src/core/account-rate-limit.ts` — policy, detector, controller
- `src/persistence/rate-limit-store.ts` — per-account overrides
- `src/core/agent-actor.ts` — acquire/release around generate
- `src/api/server.ts` — GET/PATCH routes
- `packages/pifrost/extensions/commands.ts` — `/aifrost ratelimit`
