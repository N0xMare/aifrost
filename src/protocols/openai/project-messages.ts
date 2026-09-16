/**
 * Deterministic projection of OpenAI chat messages → linear comparable turns.
 *
 * Client tool *definitions* are stripped elsewhere. This module turns tool
 * *traffic in messages* (tool_calls, role:tool, legacy function) into stable
 * text so history reconcile and WebUI submission stay programmatic — never
 * relying on the WebUI model to emit OpenAI tool protocol.
 */

import type { ComparableMessage } from "./shared.js";
import { openaiContentToText } from "./shared.js";

/**
 * Max characters of a single projected tool argument/result payload.
 * Kept modest: ChatGPT composer + CDP insertText choke on 30k+ dumps
 * (e.g. find . with node_modules), causing Runtime.evaluate timeouts.
 */
export const TOOL_PAYLOAD_MAX_CHARS = 8_192;

const TRUNC_MARK = "\n…[truncated by aifrost]";

export interface OpenAIToolCallLike {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
  name?: unknown;
  arguments?: unknown;
}

export interface OpenAIMessageLike {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  function_call?: unknown;
}

/**
 * Strip client tool-definition / tool-policy fields from a request body.
 * Mutates and returns the same object for convenience.
 * Empty tools arrays are left alone (harmless).
 */
export function stripClientToolParams<T extends Record<string, unknown>>(body: T): T {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    delete body.tools;
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    delete body.functions;
  }
  if (body.function_call !== undefined) {
    delete body.function_call;
  }
  if (body.tool_choice !== undefined) {
    delete body.tool_choice;
  }
  // Parallel tool flag is policy-only
  if (body.parallel_tool_calls !== undefined) {
    delete body.parallel_tool_calls;
  }
  return body;
}

export function truncateToolPayload(text: string, max = TOOL_PAYLOAD_MAX_CHARS): string {
  if (text.length <= max) return text;
  const budget = Math.max(0, max - TRUNC_MARK.length);
  return `${text.slice(0, budget)}${TRUNC_MARK}`;
}

/**
 * Project a single OpenAI message into zero or more comparable messages.
 * Roles after projection are only: system | developer | user | assistant.
 */
export function projectOpenAIMessage(msg: OpenAIMessageLike): ComparableMessage[] {
  const roleRaw = String(msg.role ?? "user").toLowerCase();
  const contentText = openaiContentToText(msg.content);
  const out: ComparableMessage[] = [];

  if (roleRaw === "tool" || roleRaw === "function") {
    const name = typeof msg.name === "string" && msg.name.length > 0 ? msg.name : "tool";
    const callId =
      typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 0 ? msg.tool_call_id : null;
    const header = callId
      ? `[tool_result name=${name} id=${callId}]`
      : `[tool_result name=${name}]`;
    const body = truncateToolPayload(contentText);
    out.push({
      role: "user",
      text: body ? `${header}\n${body}` : header,
    });
    return out;
  }

  if (roleRaw === "assistant") {
    // History-stable rule: assistant comparable text is **content only**.
    // tool_calls / function_call are harness-local intent — they are NOT part of
    // the WebUI transcript. Emitting them as assistant text would 409 against
    // stored plain assistant replies. Tool *results* (role:tool) carry the
    // observations as projected user messages.
    //
    // Assistant with only tool_calls and no content → drop (results follow).
    if (contentText.trim()) {
      out.push({ role: "assistant", text: contentText });
    }
    return out;
  }

  if (roleRaw === "system" || roleRaw === "developer") {
    // Harness-owned instructions (Pi system prompt, etc.). They are NOT part of
    // the durable agent transcript: we only store user + assistant turns from
    // the WebUI path. Including them in the projected stream makes every
    // multi-turn request 409 (incoming[0]=system vs stored[0]=user).
    // Drop from reconcile; optional future: fold into first user turn once.
    return out;
  }

  // user and unknown → user
  out.push({ role: "user", text: contentText });
  return out;
}

/**
 * Project a full OpenAI messages array into a linear comparable transcript.
 * Deterministic: same input always yields the same output.
 *
 * Consecutive `user` messages are coalesced with `\n\n` so multi-tool
 * observations match the single stored WebUI user turn (suffix join).
 * Without this, parallel tool_results would 409 on the next request.
 */
export function projectOpenAIMessages(messages: OpenAIMessageLike[]): ComparableMessage[] {
  const raw: ComparableMessage[] = [];
  for (const m of messages) {
    raw.push(...projectOpenAIMessage(m));
  }
  return coalesceConsecutiveUsers(raw);
}

/**
 * Join adjacent *tool_result* user turns only (parallel tools).
 * Do NOT merge a normal user message with a following tool_result — that
 * breaks prefix match after a tool_calls-only turn (stored user vs joined blob).
 */
export function coalesceConsecutiveUsers(messages: ComparableMessage[]): ComparableMessage[] {
  const out: ComparableMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "user" && prev?.role === "user") {
      const bothToolResults =
        prev.text.startsWith("[tool_result") && m.text.startsWith("[tool_result");
      if (bothToolResults) {
        const a = prev.text;
        const b = m.text;
        if (!b) {
          // skip empty
        } else if (!a) {
          prev.text = b;
        } else {
          prev.text = `${a}\n\n${b}`;
        }
        continue;
      }
    }
    out.push({ role: m.role, text: m.text });
  }
  return out;
}
