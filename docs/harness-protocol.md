# Aifrost harness protocol v1 (token-efficient PE)

Phase **A**: compact every-turn encoding for ChatGPT Web.  
Phase **B** (later): sticky re-inject only on refresh rules — encoder already splits sticky vs ephemeral.

ChatGPT **memory is assumed off** (user setting); we do not rely on product memory.

## Modes

| `AIFROST_HARNESS_PROTOCOL` | Behavior                                 |
| -------------------------- | ---------------------------------------- |
| `compact` (**default**)    | TOON-inspired tool catalog + short rules |
| `legacy`                   | Previous verbose English PE              |

## Shape (compact)

### Sticky (role + catalog + grammar)

```text
AIFROST v1 | host tools on user machine | never invent results
tools[N]{name,desc,keys}:
  bash,run shell,command|timeout
  read,read file,path|offset|limit
Rules: prose if no host IO needed; else tools only.
Args only from user/task — no default cmds.
Call form (no fences/commentary):
AIFROST_TOOL name=<name>
{json}
After [tool_result…] → more tools or final prose.

## Parse (fail-closed)

ChatGPT output → OpenAI `tool_calls`:

1. Strict balanced JSON
2. Optional trailing `"` / `}` repair only (no invented keys/values)
3. Quality gate: bash `command` must look like a real argv0 (`pwd`, `find`, `openssl`, `./script`, …). Reject quote-soup, `randomBytes`, `_DOCKERENV`, ALLCAPS crumbs.
4. First valid block only (one tool per turn)

Unusable scaffolds → adapter recovery or `tool_scaffold_incomplete`, never Pi-executed junk.
```

### Ephemeral user turn

```text
U:
<user text>
```

### Ephemeral tool continue

```text
TR host tools:bash,read,… (re-run only if still needed):
[tool_result …]
→ AIFROST_TOOL or final prose.
```

### Model output (unchanged)

Still **`AIFROST_TOOL` + JSON** — fail-closed `tryParseToolScaffold`.  
We do **not** require the model to emit TOON (parse risk).

## Host-only enforcement (critical for Pi)

ChatGPT Web often prefers **product tools** (code interpreter / agent mode) which
run in a remote sandbox (`/openai/project`, `.dockerenv`) — not the user's Mac.

Aifrost therefore:

1. PE states **HOST-ONLY** and forbids product/sandbox tools.
2. Detects sandbox fingerprints in the assistant reply.
3. If tools were requested and the model used sandbox (or ignored host need), **one corrective re-submit** with an explicit `AIFROST_TOOL` nudge.
4. Still fails retryably if the model ignores the corrective.

Pass criteria for a Pi coding turn: Pi shows local `bash`/`write` tool_calls and
`pwd` is under the user's home, not `/` + `.dockerenv`.

## Design choices

| Choice                      | Rationale                                 |
| --------------------------- | ----------------------------------------- |
| TOON-style **catalog only** | Dense JSON schemas are the main waste     |
| No sample commands          | Models copy `ls -la` etc.                 |
| Short tool continue PE      | WebUI already has task context            |
| Fingerprint helper          | Ready for Phase B refresh                 |
| No npm `@toon-format` dep   | Pure TS, no license/lock churn; same idea |

## Metrics (unit-tested)

For a typical Pi 4-tool set, compact wrap is **&lt; 55%** the chars of legacy (often ~3–5× smaller on sticky alone).

## Code

- `src/protocols/openai/harness-protocol.ts` — encode
- `src/protocols/openai/tool-intents.ts` — `wrapUserTextForHarnessTools` dispatch
- `test/unit/harness-protocol.test.ts`

## Phase B (not implemented)

Re-inject full sticky only when:

- new conversation / recover
- tool catalog fingerprint changes
- N turns or size budget
- scaffold parse failures

Until then, compact sticky is small enough to send every turn safely.
