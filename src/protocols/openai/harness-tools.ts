/**
 * Harness-local tools policy (fixture / CI only).
 *
 * Live chatgpt-web uses prompt-engineered tool selection (model emits
 * AIFROST_TOOL blocks; we parse to OpenAI tool_calls). Do NOT use the
 * hardcoded bash→ls planner for production ChatGPT — that was a temporary
 * canary and produces fake agentic loops.
 *
 * Coding harnesses (Pi) run tools on the *host*. ChatGPT product tools run
 * in a remote sandbox and are a different path.
 */

import type { CanonicalToolDefinition, CanonicalToolIntent } from "../../types/generation.js";
import { planFixtureToolIntents } from "./tool-intents.js";

export type HarnessToolsMode = "auto" | "always" | "never";

export function resolveHarnessToolsMode(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): HarnessToolsMode {
  const raw = (env.AIFROST_HARNESS_TOOLS ?? "auto").trim().toLowerCase();
  if (raw === "always" || raw === "1" || raw === "true" || raw === "on") {
    return "always";
  }
  if (raw === "never" || raw === "0" || raw === "false" || raw === "off") {
    return "never";
  }
  return "auto";
}

/** Heuristic: pure social / ack chat should hit the model, not force bash. */
export function looksLikePureChat(userText: string): boolean {
  const t = userText.trim();
  if (!t) return true;
  if (t.length > 160) return false;
  // Tool observations always go to the model path (never re-emit tool_calls)
  if (t.includes("[tool_result")) return false;

  const pure =
    /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|test|ping|pong|how are you|how's it going|good morning|good night|what'?s up)[\s!?.]*$/i;
  if (pure.test(t)) return true;

  // Explicit coding / tool intent
  if (
    /\b(ls|pwd|cat |read |write |edit |fix |bug|implement|refactor|git |npm |test |build |file|directory|repo|package\.json|src\/)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\b(please|can you|could you).{0,40}\b(list|show|run|execute|open|inspect)\b/i.test(t)) {
    return false;
  }
  // Short vague chat without coding verbs → model
  if (t.length < 40 && !/[`/\\]|\.\w{1,4}\b/.test(t)) return true;
  return false;
}

/**
 * Decide whether this turn should return OpenAI tool_calls for the harness
 * instead of (or before) WebUI generation.
 */
export function planHarnessToolIntents(opts: {
  userText: string;
  tools: CanonicalToolDefinition[];
  mode?: HarnessToolsMode;
  env?: Record<string, string | undefined>;
}): CanonicalToolIntent[] | null {
  const mode = opts.mode ?? resolveHarnessToolsMode(opts.env);
  if (mode === "never") return null;
  if (!opts.tools.length && mode !== "always") {
    // still allow AIFROST_TOOL scaffold via planFixtureToolIntents
  }
  if (opts.userText.includes("[tool_result")) return null;

  if (mode === "auto" && looksLikePureChat(opts.userText)) {
    return null;
  }

  return planFixtureToolIntents({
    userText: opts.userText,
    tools: opts.tools,
  });
}
