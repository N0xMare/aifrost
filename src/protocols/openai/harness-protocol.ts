/**
 * Aifrost harness protocol v1 — token-efficient PE for ChatGPT Web.
 *
 * Phase A (this module): compact **every-turn** encoding of sticky protocol +
 * ephemeral user/tool_result payloads. Model **output** grammar stays
 * AIFROST_TOOL + JSON (fail-closed parse unchanged).
 *
 * Sticky vs ephemeral are split in the encoder so Phase B can re-inject sticky
 * only on refresh rules (not every turn). Phase A still concatenates both each
 * turn, but sticky is ~5–10× smaller than the legacy English dump.
 *
 * Tool catalogs use a TOON-inspired tabular form (no extra dependency):
 *   tools[N]{name,desc,keys}:
 *     bash,run shell,command|timeout
 *
 * Memory is assumed off (user disabled ChatGPT memory) — protocol does not
 * rely on product memory.
 */

import type { CanonicalToolDefinition } from "../../types/generation.js";

export type HarnessProtocolMode = "compact" | "legacy";

export function resolveHarnessProtocolMode(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): HarnessProtocolMode {
  const raw = (env.AIFROST_HARNESS_PROTOCOL ?? "compact").trim().toLowerCase();
  if (raw === "legacy" || raw === "verbose" || raw === "full") return "legacy";
  return "compact";
}

/** Short desc for catalog rows (token budget). */
export function compactToolDescription(desc: string | undefined): string {
  if (!desc) return "";
  const one = desc.replace(/\s+/g, " ").trim();
  if (one.length <= 48) return one;
  return `${one.slice(0, 45)}...`;
}

/** Pull top-level JSON Schema property names for the catalog. */
export function toolParamKeys(parameters: unknown, max = 10): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const props = (parameters as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props as Record<string, unknown>).slice(0, max);
}

/**
 * TOON-inspired tool catalog (tabular). Deterministic and human-readable.
 * Escapes commas in fields with a simple replace so rows stay single-line.
 */
export function encodeToolCatalogToon(tools: CanonicalToolDefinition[]): string {
  const n = tools.length;
  if (n === 0) return "tools[0]{name,desc,keys}:";
  const lines = tools.map((t) => {
    const name = sanitizeField(t.name);
    const desc = sanitizeField(compactToolDescription(t.description));
    const keys = toolParamKeys(t.parameters).map(sanitizeField).join("|");
    return `  ${name},${desc},${keys}`;
  });
  return [`tools[${n}]{name,desc,keys}:`, ...lines].join("\n");
}

function sanitizeField(s: string): string {
  // Keep row CSV-ish; avoid newlines/commas breaking the table.
  return s
    .replace(/[\n\r,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fingerprint of tool set for Phase B refresh (stable string). */
export function toolCatalogFingerprint(tools: CanonicalToolDefinition[]): string {
  return tools
    .map((t) => {
      const keys = toolParamKeys(t.parameters).join("|");
      return `${t.name}:${keys}`;
    })
    .join(";");
}

/**
 * Sticky protocol (role + grammar + catalog). Compact English + TOON table.
 * No sample shell commands (models copy them).
 *
 * Host-only: ChatGPT product tools (code interpreter / agent / /openai/project
 * sandbox) are forbidden — Pi runs tools on the user's real machine.
 */
export function buildStickyProtocolV1(tools: CanonicalToolDefinition[]): string {
  const catalog = encodeToolCatalogToon(tools);
  return [
    "AIFROST v1 | HOST-ONLY tools via Pi on the user's real laptop",
    "FORBIDDEN: ChatGPT product tools, code interpreter, remote sandbox, /openai/project, .dockerenv, browsing-as-tool.",
    "You have NO filesystem except through AIFROST_TOOL blocks below. Never invent file trees or cmd output.",
    catalog,
    "Rules:",
    "- Pure chat/knowledge → plain prose only (no tools, no sandbox).",
    "- Need host cwd/files/shell/scripts → emit AIFROST_TOOL only (no prose before tools).",
    "- Emit exactly ONE AIFROST_TOOL block per turn (full balanced JSON). Wait for [tool_result] before another.",
    "- Args only from user/task — no default cmds.",
    "Call form (no fences/commentary):",
    "AIFROST_TOOL name=<name>",
    "{json}",
    "After [tool_result…] → more AIFROST_TOOL or final prose with real results only.",
  ].join("\n");
}

/**
 * Strip AIFROST_TOOL blocks (and their JSON args) so host commands that
 * *probe* sandbox paths (e.g. cat /.dockerenv) are not mistaken for product-tool use.
 */
export function stripAifrostToolBlocksForSandboxScan(text: string): string {
  let t = text || "";
  // Remove AIFROST_TOOL name=… + following JSON object (balanced)
  const headerRe = /AIFROST_TOOL\s+name=[A-Za-z0-9_.-]+\s*(?:arguments\s*=\s*)?/gi;
  let m: RegExpExecArray | null;
  const ranges: Array<{ start: number; end: number }> = [];
  while ((m = headerRe.exec(t)) !== null) {
    const start = m.index;
    let i = start + m[0].length;
    // skip whitespace
    while (i < t.length && /\s/.test(t[i]!)) i += 1;
    if (t[i] === "{") {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < t.length; j++) {
        const ch = t[j]!;
        if (inStr) {
          if (esc) {
            esc = false;
            continue;
          }
          if (ch === "\\") {
            esc = true;
            continue;
          }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') {
          inStr = true;
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            ranges.push({ start, end: j + 1 });
            break;
          }
        }
      }
    } else {
      ranges.push({ start, end: start + m[0].length });
    }
  }
  // remove from end so indices stay valid
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k]!;
    t = t.slice(0, r.start) + " " + t.slice(r.end);
  }
  return t;
}

/**
 * Detect ChatGPT product-tool / remote-sandbox fingerprints in assistant text.
 * Used to reject turns that ignored host PE and ran in OpenAI's environment.
 *
 * Important:
 * - host AIFROST_TOOL payloads that *mention* .dockerenv or /openai/project
 *   (adversarial probes) must NOT count as product-sandbox use.
 * - final prose that *answers* a host dockerenv probe ("no .dockerenv", NO_DOCKERENV,
 *   /Users/…) must NOT count — that is the intended host-tool outcome.
 */
export function looksLikeChatGptProductSandbox(text: string): boolean {
  const raw = text || "";
  if (!raw.trim()) return false;
  // If the model emitted host tool blocks, only scan prose outside them.
  const t = stripAifrostToolBlocksForSandboxScan(raw);
  // Remaining is only AIFROST_TOOL blocks → treat as host protocol attempt
  if (!t.replace(/\s+/g, "").length && /AIFROST_TOOL/i.test(raw)) {
    return false;
  }

  // Unambiguous product / remote-agent markers (any one is enough)
  const strong = [
    /\/openai\/project\b/i,
    /\/home\/oai\//i,
    /\bcaas_toolbox\b/i,
    /\bcua_chrome\b/i,
    /\bSystem\.map-.*deb\d+/i,
    /\bInspected project files\b/i,
    /\bGenerating hashed report\b/i,
    /\bWorked for \d+s\b/i,
    /\bexecution environment exposed to me starts at \/\b/i,
    /\bno AIFROST project repository or source tree was mounted\b/i,
    /\b\/mnt\/data\b/i,
  ];
  for (const re of strong) {
    if (re.test(t)) return true;
  }

  // Host-local framing: model is reporting laptop results, not a remote sandbox.
  // Common after bash pwd / .dockerenv probes via AIFROST_TOOL.
  const hostLocal =
    /\/Users\/[^\s]+/.test(t) ||
    /\bNO_DOCKERENV\b/.test(t) ||
    /\bno (such file|\.dockerenv)\b/i.test(t) ||
    /\.dockerenv (does not|doesn't) exist/i.test(t) ||
    /\bnot (present|found) on (the )?(host|laptop|machine)\b/i.test(t);

  // .dockerenv alone is only a product signal when NOT framed as host-local answer.
  // (Product sandboxes usually also hit strong markers above.)
  if (/\.dockerenv\b/i.test(t) && !hostLocal) {
    // Require a second weak signal so "I won't check .dockerenv" alone is not enough
    // to hard-fail, but "ran in sandbox; .dockerenv; bash -lc" still is.
    const weak = [/\bbash -lc\b/i, /\bremote sandbox\b/i, /\bcode interpreter\b/i];
    let extra = 0;
    for (const re of weak) {
      if (re.test(t)) extra += 1;
    }
    if (extra >= 1) return true;
    // Bare ".dockerenv" in a path inventory without /Users is still suspicious
    if (/^[\s\S]{0,40}\.dockerenv\b/m.test(t) && /total \d+|drwx|bin\/bash/i.test(t)) {
      return true;
    }
  }

  // Multi weak-hit fallback (no strong marker)
  const weakHits = [
    /\bbash -lc\b/i,
    /\bremote sandbox\b/i,
    /\bcode interpreter\b/i,
    /\bcontainer filesystem\b/i,
  ];
  let n = 0;
  for (const re of weakHits) {
    if (re.test(t)) n += 1;
  }
  return n >= 2;
}

/**
 * Strong product-tool markers only — used on tool_result continues where the
 * model is allowed to restate probe words (.dockerenv) in final prose.
 */
export function looksLikeStrongProductSandbox(text: string): boolean {
  const t = stripAifrostToolBlocksForSandboxScan(text || "");
  if (!t.trim()) return false;
  return (
    /\/openai\/project\b/i.test(t) ||
    /\/home\/oai\//i.test(t) ||
    /\bcaas_toolbox\b/i.test(t) ||
    /\bcua_chrome\b/i.test(t) ||
    /\b\/mnt\/data\b/i.test(t) ||
    /\bWorked for \d+s\b/i.test(t) ||
    /\bInspected project files\b/i.test(t) ||
    /\bexecution environment exposed to me starts at \/\b/i.test(t)
  );
}

/**
 * User text that likely requires real host I/O (not pure chat).
 * Never treat tool_result observations as "needs host" — those are continues
 * where final prose is allowed; matching `.js` / `script` inside results caused
 * infinite corrective→bash loops.
 */
export function userLikelyNeedsHostTools(userText: string): boolean {
  const t = (userText || "").trim();
  if (!t) return false;
  if (t.includes("[tool_result")) return false;
  if (looksLikeProseOnlyRequest(t)) return false;
  return /\b(directory|directories|filesystem|codebase|repo|repository|cwd|pwd|working directory|file structure|package\.json|src\/|write a |create a |script|chessboard|\.js\b|random hex|openssl|bash|terminal|investigate|research\/investigate|list files|ls\b)\b/i.test(
    t,
  );
}

/**
 * Model refused to emit AIFROST_TOOL (common after STOP nudge on adversarial prompts).
 * Fail fast — do not wait full capture timeout or re-nudge forever.
 */
export function looksLikeAifrostToolRefusal(text: string): boolean {
  const t = text || "";
  // Match straight or curly apostrophes (ChatGPT often emits ’)
  const cant = /can[’']?t/i;
  return (
    /can[’']?t emit or execute AIFROST_TOOL/i.test(t) ||
    /AIFROST_TOOL blocks because those are not tools available/i.test(t) ||
    /not tools available in this ChatGPT environment/i.test(t) ||
    /won[’']?t fabricate filesystem or shell results/i.test(t) ||
    /those are not tools available in this ChatGPT/i.test(t) ||
    (cant.test(t) && /perform the write/i.test(t)) ||
    /cannot perform the write/i.test(t) ||
    /can[’']?t (create|write|emit).{0,40}AIFROST/i.test(t) ||
    /not able to (emit|use|run) AIFROST_TOOL/i.test(t) ||
    /AIFROST_TOOL.{0,40}(not available|unavailable)/i.test(t) ||
    /inROST_TOOL/i.test(t) // garbled capture of "AIFROST_TOOL" after partial refusal
  );
}

/**
 * User explicitly wants no tools / pure prose this turn.
 * Used to avoid PE that pushes AIFROST_TOOL on "say exactly X" prompts.
 */
export function looksLikeProseOnlyRequest(userText: string): boolean {
  const t = (userText || "").trim();
  if (!t || t.includes("[tool_result")) return false;
  if (
    /\b(do not use (any )?tools|without tools|no tools|prose only|exactly one line|reply with exactly)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // Ultra-short social/ack (mirrors harness-tools pure chat core)
  if (t.length <= 80) {
    if (
      /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|test|ping|pong)[\s!?.]*$/i.test(t)
    ) {
      return true;
    }
  }
  return false;
}

/** Corrective nudge after a sandbox / non-host turn (auto-retry). */
export function buildHostOnlyCorrectiveNudge(
  userText: string,
  tools: CanonicalToolDefinition[],
): string {
  const names = tools.map((t) => t.name).join(", ") || "bash,read,edit,write";
  // Never paste full tool_result blobs into the nudge (context pollution + loops)
  const isToolContinue = userText.includes("[tool_result");
  const original = isToolContinue
    ? "(continue from prior host tool_results — emit AIFROST_TOOL only if still needed, else final prose)"
    : userText.trim().slice(0, 1200);
  // Avoid fingerprint strings (/openai/project, .dockerenv, sample shell cmds)
  // that poison DOM capture and get re-classified as sandbox or copied as tools.
  if (isToolContinue) {
    return [
      "STOP. Prior reply was invalid for Aifrost host protocol.",
      "You have NO remote product shell. Tools already ran on the user's laptop.",
      `If you still need host I/O: emit AIFROST_TOOL only (names: ${names}).`,
      "Otherwise: final plain prose summarizing the host tool_results only.",
      "Do not invent paths. Do not use product tools.",
    ].join("\n");
  }
  return [
    "STOP. Previous reply ignored Aifrost host protocol.",
    "You have NO remote product shell and NO laptop filesystem access except AIFROST_TOOL.",
    `ONLY allowed actions: emit AIFROST_TOOL with names: ${names}`,
    "Emit one AIFROST_TOOL block NOW (no prose first):",
    "AIFROST_TOOL name=<name>",
    "{...json args from the user request only...}",
    "Do not use product tools. Do not invent file trees or command output.",
    "Original user request:",
    original,
  ].join("\n");
}

/** Ephemeral user turn body. */
export function buildEphemeralUserTurnV1(userText: string): string {
  return `U:\n${userText.trim()}`;
}

/**
 * Ephemeral tool-result continue. Tool bodies already truncated upstream;
 * keep PE chrome minimal (single tools: list, no footer duplicate).
 */
export function buildEphemeralToolContinueV1(
  toolResultText: string,
  tools: CanonicalToolDefinition[],
): string {
  const names = tools.map((t) => t.name).join(",") || "-";
  return [
    `TR HOST tools:${names} (from user's laptop; re-run only if still needed):`,
    toolResultText.trim(),
    "Use these host results. Prefer final plain prose. More AIFROST_TOOL only if still needed. No product tools.",
  ].join("\n");
}

/**
 * Full WebUI user payload for a normal (non-tool_result) turn.
 * Phase A: sticky + ephemeral every time.
 */
export function composeHarnessTurnV1(
  userText: string,
  tools: CanonicalToolDefinition[],
  opts?: { includeSticky?: boolean },
): string {
  const includeSticky = opts?.includeSticky !== false;
  if (userText.includes("[tool_result")) {
    // Tool continue: ephemeral only (catalog already in prior turns / short header)
    return buildEphemeralToolContinueV1(userText, tools);
  }
  // Explicit no-tool / pure-prose turns: do not push AIFROST_TOOL
  if (looksLikeProseOnlyRequest(userText)) {
    return [
      "AIFROST v1 | this turn: PLAIN PROSE ONLY",
      "Do not call tools. Do not emit AIFROST_TOOL. Do not list files or run commands.",
      buildEphemeralUserTurnV1(userText),
    ].join("\n");
  }
  const parts: string[] = [];
  if (includeSticky) {
    parts.push(buildStickyProtocolV1(tools));
    // Lift any earlier "prose only" restriction that may still sit in WebUI history
    parts.push(
      "NOTE: Any prior PLAIN PROSE ONLY restriction in this chat is LIFTED for this turn. Host AIFROST_TOOL is allowed and required when the user needs files/shell.",
    );
  }
  parts.push(buildEphemeralUserTurnV1(userText));
  return parts.join("\n");
}

/**
 * Strip harness PE chrome if the model/DOM echoed the submitted wrap into
 * "assistant" text. Pure helper for capture cleanup + unit tests.
 *
 * Returns remaining model text, or "" if only PE chrome / tool observations.
 * Callers still apply stripUserEchoPrefix(lastUserText) afterward.
 */
export function stripHarnessPeEcho(assistant: string): string {
  let s = (assistant || "").trim();
  if (!s) return "";

  // Compact user turn: sticky … \nU:\n<body>[…model…]
  if (/^AIFROST v1\b/i.test(s)) {
    const uIdx = s.search(/\nU:\n/);
    if (uIdx >= 0) {
      return s.slice(uIdx + "\nU:\n".length).trim();
    }
  }

  // Tool continue wrap
  if (/^AIFROST v1\b/i.test(s) || /^TR host\b/i.test(s)) {
    s = s.replace(/^AIFROST v1[^\n]*\n?/i, "").trim();
    s = s.replace(/^TR host[^\n]*\n?/i, "").trim();
    // Strip PE footer line only (must not eat model final prose after a blank line)
    s = s
      .replace(/\n→\s*AIFROST_TOOL or final prose[^\n]*/gi, "")
      .replace(/\nFORBIDDEN:[^\n]*/gi, "")
      .replace(/\nUse these host results\.[^\n]*/gi, "")
      .trim();

    if (/\bAIFROST_TOOL\b/.test(s) && !/^\[tool_result\b/i.test(s)) {
      // Model requested more tools — keep from first AIFROST_TOOL
      const idx = s.indexOf("AIFROST_TOOL");
      return s.slice(idx).trim();
    }

    // Split observation vs model reply on blank line after tool_result body
    if (/^\[tool_result\b/i.test(s)) {
      const parts = s.split(/\n\n+/);
      if (parts.length >= 2) {
        const tail = parts
          .slice(1)
          .join("\n\n")
          .trim()
          .replace(/^Use these host results\.[^\n]*\n?/i, "")
          .trim();
        if (tail && !tail.startsWith("[tool_result")) return tail;
      }
      // No clear model reply — pure observation echo
      return "";
    }
  }

  // Legacy PE
  if (/^You are the reasoning model for a local coding agent/i.test(s)) {
    const marker = "USER REQUEST:";
    const idx = s.indexOf(marker);
    if (idx >= 0) s = s.slice(idx + marker.length).trim();
    else s = "";
  }

  return s;
}

/** Char stats for tests / metrics. */
export function measureHarnessWrap(text: string): { chars: number; lines: number } {
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split("\n").length,
  };
}
