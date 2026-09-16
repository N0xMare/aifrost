# Implementation status

Product: **chatgpt.com Chat as a local OpenAI-compatible token engine.**  
Pi/pifrost is the reference consumer. Work / other providers are out of scope.

## Done

- Native `/v1/agents` + SQLite
- Brave process-per-account, project `aifrost` chats
- Completions/Responses mounts, stateful history
- Host `AIFROST_TOOL` → `tool_calls` (Pi executes)
- Per-account rate limits (env, HTTP, pifrost)
- Incomplete-scaffold wait + lenient parse + up to two in-adapter nudges
- L1 smoke scripts; L2 `pi -p` proven on simple bash

## Remaining (reliability)

1. Heavy first-turn `AIFROST_TOOL` JSON still truncates sometimes — nudges exist; prove on chessboard `pi -p`
2. pifrost/Pi does not retry HTTP errors; Aifrost must recover internally
3. Settings UI apply (model/effort) stays best-effort
4. Phase B sticky PE (catalog not every turn)

## Not doing for v0.1

Anthropic gateway, ChatGPT Work, multi-provider expansion, full keystroke humanize.
