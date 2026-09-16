/**
 * OpenAI tool_calls façade helpers — extract client tools, encode intents,
 * optional fail-closed text scaffold parse for future WebUI emulation.
 *
 * WebUI PE encoding: see harness-protocol.ts (compact v1 default).
 */

import type { CanonicalToolDefinition, CanonicalToolIntent } from "../../types/generation.js";
import { newGenerationId } from "../../types/ids.js";
import { composeHarnessTurnV1, resolveHarnessProtocolMode } from "./harness-protocol.js";

/** Extract OpenAI tools[] into canonical defs (before strip). */
export function extractClientToolDefinitions(
  body: Record<string, unknown>,
): CanonicalToolDefinition[] {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const out: CanonicalToolDefinition[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    // OpenAI: { type: "function", function: { name, description, parameters } }
    if (obj.type === "function" && obj.function && typeof obj.function === "object") {
      const fn = obj.function as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      out.push({
        name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: fn.parameters,
        kind: "client_function",
      });
      continue;
    }
    // Flat: { name, description, parameters }
    if (typeof obj.name === "string" && obj.name) {
      out.push({
        name: obj.name,
        description: typeof obj.description === "string" ? obj.description : undefined,
        parameters: obj.parameters,
        kind: "client_function",
      });
    }
  }
  return out;
}

export function toolIntentArgumentsToString(args: CanonicalToolIntent["arguments"]): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

export function newToolCallId(): string {
  // OpenAI-ish id without requiring crypto in all envs
  const bare = newGenerationId().replace(/^gen_/, "");
  return `call_${bare}`;
}

/** OpenAI message.tool_calls array from intents. */
export function toolIntentsToOpenAIToolCalls(intents: CanonicalToolIntent[]): Array<{
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  return intents.map((intent) => ({
    id: intent.id || newToolCallId(),
    type: "function" as const,
    function: {
      name: intent.name,
      arguments: toolIntentArgumentsToString(intent.arguments),
    },
  }));
}

/**
 * Fail-closed parse of model-emitted tool requests (prompt-engineered).
 * JSON only — no repair, no semantic gate (see parseHostToolIntents).
 *
 *   AIFROST_TOOL name=bash
 *   {"command":"ls"}
 */
export function tryParseToolScaffold(text: string): CanonicalToolIntent[] | null {
  const trimmed = text.trim();
  if (!trimmed.includes("AIFROST_TOOL")) return null;

  const intents: CanonicalToolIntent[] = [];
  const headerRe = /AIFROST_TOOL\s+name=([A-Za-z0-9_.-]+)\s*(?:arguments\s*=\s*)?/gi;
  let m: RegExpExecArray | null;
  let anyInvalid = false;
  while ((m = headerRe.exec(trimmed)) !== null) {
    const name = m[1]!;
    const after = trimmed.slice(m.index + m[0].length);
    const raw = extractBalancedJsonObject(after);
    if (!raw) {
      anyInvalid = true;
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      intents.push({ id: newToolCallId(), name, arguments: parsed });
    } catch {
      anyInvalid = true;
    }
  }
  if (anyInvalid && intents.length === 0) return null;
  if (intents.length > 0) return intents;
  return null;
}

/** Extract first top-level `{…}` with string-aware brace balance. */
export function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Legacy verbose instruction block (AIFROST_HARNESS_PROTOCOL=legacy).
 * Default path uses compact v1 in harness-protocol.ts.
 *
 * Critical: do NOT put a realistic sample command (e.g. ls -la) in the prompt —
 * ChatGPT copies examples. Keep the format skeleton only.
 */
export function buildHarnessToolInstruction(tools: CanonicalToolDefinition[]): string {
  const lines = tools.map((t) => {
    const params =
      t.parameters != null
        ? ` parameters schema: ${JSON.stringify(t.parameters).slice(0, 400)}`
        : "";
    return `- ${t.name}${t.description ? `: ${t.description}` : ""}${params}`;
  });
  const names = tools.map((t) => t.name).join(", ") || "(none)";
  return [
    "You are the reasoning model for a local coding agent on the user's machine.",
    "HOST tools run on the user's laptop (not a remote sandbox). You never invent tool results.",
    "",
    `Available tools (names only: ${names}):`,
    ...lines,
    "",
    "Decision rules:",
    "1. If you can answer from knowledge (chat, explain, write code/text the user asked for), reply in plain prose ONLY. Do not mention tools.",
    "2. Call a tool ONLY when the task needs live machine state, filesystem I/O, or a command the user asked you to run.",
    "3. Arguments must come from the USER REQUEST. Never invent a default command. Never reuse a prior command unless the user asked again.",
    "4. When calling tools, output one or more blocks in this exact form and nothing else (no markdown fences, no commentary):",
    "AIFROST_TOOL name=<tool_name>",
    "{...json arguments matching that tool's schema...}",
    "",
    "After tools run you will receive [tool_result ...] observations; then call more tools or give the final answer.",
  ].join("\n");
}

/**
 * Streaming wait: header present but JSON not balanced yet.
 * Do not apply the quality gate here (partial `{"command":"openssl rand` is still streaming).
 */
export function looksLikeIncompleteToolScaffold(text: string): boolean {
  const t = (text || "").trim();
  if (!t.includes("AIFROST_TOOL")) return false;
  if (tryParseToolScaffold(t)) return false;
  const opens = (t.match(/\{/g) ?? []).length;
  const closes = (t.match(/\}/g) ?? []).length;
  if (opens > closes) return true;
  if (/AIFROST_TOOL\s+name=[A-Za-z0-9_.-]+\s*$/m.test(t)) return true;
  if (opens === 0) return true;
  return false;
}

/**
 * Product parser for chatgpt-web → OpenAI tool_calls.
 *
 * Pipeline (fail-closed):
 *  1. Strict balanced JSON (tryParseToolScaffold)
 *  2. Optional trailing-only repair: close dangling `"` / `}` (never invent keys/values)
 *  3. Semantic quality gate — reject capture/PE fragments
 *  4. First valid block only (PE: one tool per turn)
 *
 * Garbage like `command:"').randomBytes…"` or `" HEX STRING ==='; openssl…"`
 * must return null so the adapter nudges or fails `tool_scaffold_incomplete`
 * instead of Pi executing junk.
 */
export function parseHostToolIntents(text: string): CanonicalToolIntent[] | null {
  const strict = filterSaneIntents(tryParseToolScaffold(text));
  if (strict) return strict.slice(0, 1);
  const repaired = filterSaneIntents(tryParseToolScaffoldLenient(text));
  if (repaired) return repaired.slice(0, 1);
  return null;
}

/**
 * True after the model has stopped: AIFROST_TOOL was attempted but nothing
 * usable survived the quality gate (truncated or garbage). Adapter recovery.
 */
export function needsToolScaffoldRecovery(text: string): boolean {
  const t = (text || "").trim();
  if (!t.includes("AIFROST_TOOL")) return false;
  return parseHostToolIntents(t) === null;
}

/**
 * Best-effort repair of truncated AIFROST_TOOL JSON (stop mid-object).
 * Only appends closing quotes/braces. Never invents tool names or arg values.
 */
export function tryParseToolScaffoldLenient(text: string): CanonicalToolIntent[] | null {
  const trimmed = (text || "").trim();
  if (!trimmed.includes("AIFROST_TOOL")) return null;
  const strict = tryParseToolScaffold(trimmed);
  if (strict) return strict;

  const headerRe = /AIFROST_TOOL\s+name=([A-Za-z0-9_.-]+)\s*(?:arguments\s*=\s*)?/gi;
  const m = headerRe.exec(trimmed);
  if (!m) return null;
  const after = trimmed.slice(m.index + m[0].length);
  const start = after.indexOf("{");
  if (start < 0) return null;
  const fragment = after.slice(start);
  if (extractBalancedJsonObject(fragment)) return null;

  const opens = (fragment.match(/\{/g) ?? []).length;
  const closes = (fragment.match(/\}/g) ?? []).length;
  const missing = opens - closes;
  if (missing < 1 || missing > 3) return null;

  const candidates = [
    fragment + "}".repeat(missing),
    fragment + '"' + "}".repeat(missing),
    fragment + '"}' + "}".repeat(Math.max(0, missing - 1)),
  ];
  for (const c of candidates) {
    if (!extractBalancedJsonObject(c)) continue;
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const intent: CanonicalToolIntent = {
        id: newToolCallId(),
        name: m[1]!,
        arguments: parsed,
      };
      if (!intentArgsAreSane(intent)) continue;
      return [intent];
    } catch {
      continue;
    }
  }
  return null;
}

export function filterSaneIntents(
  intents: CanonicalToolIntent[] | null,
): CanonicalToolIntent[] | null {
  if (!intents || intents.length === 0) return null;
  const ok = intents.filter((it) => intentArgsAreSane(it));
  return ok.length > 0 ? ok : null;
}

/** True when parsed tool args look like DOM/PE fragments, not real host tools. */
export function intentsLookLikeCaptureGarbage(intents: CanonicalToolIntent[]): boolean {
  return intents.some((it) => !intentArgsAreSane(it));
}

export function intentArgsAreSane(intent: CanonicalToolIntent): boolean {
  const args =
    intent.arguments && typeof intent.arguments === "object"
      ? (intent.arguments as Record<string, unknown>)
      : {};
  if (/bash|shell|exec/i.test(intent.name)) {
    return shellCommandLooksRunnable(String(args.command ?? ""));
  }
  if (/write|edit|read/i.test(intent.name)) {
    return hostPathLooksReal(String(args.path ?? ""));
  }
  return Object.keys(args).length > 0;
}

/**
 * Host bash command must look like something a human would type.
 * Rejects quote-soup, JS snippets, PE crumbs, ALLCAPS markers.
 */
export function shellCommandLooksRunnable(command: string): boolean {
  const cmd = (command || "").trim();
  if (cmd.length < 2) return false;
  if (/^['"`)\]},]/.test(cmd)) return false;
  if (/^_?(NO_)?DOCKERENV$/i.test(cmd)) return false;
  if (/\bAIFROST_TOOL\b|randomBytes|toString\(\s*['"]hex['"]\s*\)/i.test(cmd)) {
    return false;
  }
  if (/HEX STRING\s*===/i.test(cmd)) return false;
  if (unbalancedShellQuotes(cmd)) return false;
  const first = cmd.split(/\s+/)[0] ?? "";
  if (!first) return false;
  if (/^[A-Z]{2,}$/.test(first)) return false; // HEX, STRING, AIF
  if (/^[./~]/.test(first)) return true; // ./script, /usr/bin/…, ~/bin
  if (/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(first)) return true;
  return false;
}

export function hostPathLooksReal(path: string): boolean {
  const p = (path || "").trim();
  if (p.length < 2) return false;
  if (/[\n\r\0]/.test(p)) return false;
  if (/^['"`]/.test(p)) return false;
  return /^[./~\w-]+(?:\/[.\w-]+)*$/.test(p);
}

function unbalancedShellQuotes(cmd: string): boolean {
  let sq = false;
  let dq = false;
  let esc = false;
  for (const ch of cmd) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && dq) {
      esc = true;
      continue;
    }
    if (ch === "'" && !dq) sq = !sq;
    else if (ch === '"' && !sq) dq = !dq;
  }
  return sq || dq;
}

/** Short re-nudge when the model emitted a truncated AIFROST_TOOL scaffold. */
export function buildIncompleteToolScaffoldNudge(tools: CanonicalToolDefinition[]): string {
  const names = tools.map((t) => t.name).join(", ") || "bash,read,write";
  return [
    "STOP. Your previous AIFROST_TOOL output was truncated (incomplete JSON).",
    `Re-emit ONE complete AIFROST_TOOL block now for names: ${names}`,
    "Format exactly:",
    "AIFROST_TOOL name=<name>",
    "{...complete balanced json...}",
    "No prose before or after. No markdown fences. Full closing braces.",
  ].join("\n");
}

/**
 * Wrap user turn for WebUI when tools are active.
 * Default: compact protocol v1 (AIFROST_HARNESS_PROTOCOL=compact).
 * Set AIFROST_HARNESS_PROTOCOL=legacy for the previous verbose PE.
 */
export function wrapUserTextForHarnessTools(
  userText: string,
  tools: CanonicalToolDefinition[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  if (!tools.length) return userText;
  const mode = resolveHarnessProtocolMode(env);
  if (mode === "compact") {
    return composeHarnessTurnV1(userText, tools);
  }
  // legacy
  if (userText.includes("[tool_result")) {
    return [
      "Host tool results from the coding agent (do not re-run the same command unless still needed):",
      userText,
      "",
      "Continue the original user task. Either:",
      "- call more tools with AIFROST_TOOL blocks only, or",
      "- give the final answer in plain text (no AIFROST_TOOL).",
      "",
      "Available tool names: " + tools.map((t) => t.name).join(", "),
      "Format if calling a tool:",
      "AIFROST_TOOL name=<tool_name>",
      "{...json arguments...}",
    ].join("\n");
  }
  return [buildHarnessToolInstruction(tools), "", "USER REQUEST:", userText].join("\n");
}

/**
 * Fixture / emulated policy: pick a tool_call from client tools + user text.
 * Returns null when the turn should be a normal text completion instead.
 */
export function planFixtureToolIntents(opts: {
  userText: string;
  tools: CanonicalToolDefinition[];
}): CanonicalToolIntent[] | null {
  const text = opts.userText;
  // After harness ran tools, projected observations look like this
  if (text.includes("[tool_result")) {
    return null;
  }
  if (!opts.tools.length) {
    // Explicit scaffold without tools list still allowed
    return tryParseToolScaffold(text);
  }

  const scaffold = tryParseToolScaffold(text);
  if (scaffold) return scaffold;

  const names = opts.tools.map((t) => t.name);
  const pick =
    names.find((n) => n === "bash" || n.endsWith("_bash")) ??
    names.find((n) => n === "read" || n === "read_file" || n.includes("read")) ??
    names[0]!;

  if (pick === "bash" || pick.endsWith("_bash")) {
    return [
      {
        id: newToolCallId(),
        name: pick,
        arguments: {
          command: "pwd && ls -la",
        },
      },
    ];
  }
  if (pick === "read" || pick === "read_file" || pick.includes("read")) {
    return [
      {
        id: newToolCallId(),
        name: pick,
        arguments: {
          path: "package.json",
        },
      },
    ];
  }
  return [
    {
      id: newToolCallId(),
      name: pick,
      arguments: {
        input: text.slice(0, 500),
      },
    },
  ];
}
