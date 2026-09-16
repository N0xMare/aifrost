/**
 * Shared OpenAI protocol helpers — history reconciliation, content extraction,
 * model label, error encoding. No DOM / provider logic.
 */

import type { Agent } from "../../types/agent.js";
import { AifrostException, err } from "../../types/errors.js";
import type { AifrostError } from "../../types/errors.js";
import type { AgentId, GenerationId, MessageId } from "../../types/ids.js";
import { newGenerationId, newMessageId } from "../../types/ids.js";
import type { CanonicalGenerationRequest } from "../../types/generation.js";
import type { NormalizedMessage } from "../../types/messages.js";
import { extractPlainText, textContent } from "../../types/messages.js";
import type { ProtocolHttpResponse } from "../contract.js";

const textEncoder = new TextEncoder();

export function encodeSseData(data: unknown): Uint8Array {
  return textEncoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function encodeSseDone(): Uint8Array {
  return textEncoder.encode("data: [DONE]\n\n");
}

export function encodeUtf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** Extract plain text from OpenAI message content (string | parts array). */
export function openaiContentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "input_text" && typeof p.text === "string") return p.text;
          if (p.type === "output_text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && content !== null && "text" in content) {
    return String((content as { text: unknown }).text ?? "");
  }
  return "";
}

export interface ComparableMessage {
  role: string;
  text: string;
}

export function comparableFromNormalized(m: NormalizedMessage): ComparableMessage {
  return { role: m.role, text: extractPlainText(m) };
}

export function comparableFromOpenAI(msg: {
  role?: unknown;
  content?: unknown;
}): ComparableMessage {
  return {
    role: String(msg.role ?? "user"),
    text: openaiContentToText(msg.content),
  };
}

export function normalizeMatchText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Match history rows. Assistants are fuzzy: stream clients often keep a
 * slightly different view (whitespace, accidental user-prefix glue) than the
 * cleaned text we store from the WebUI final scrape.
 */
export function messagesMatch(a: ComparableMessage, b: ComparableMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.text === b.text) return true;
  if (normalizeMatchText(a.text) === normalizeMatchText(b.text)) return true;

  if (a.role === "assistant") {
    const x = normalizeMatchText(a.text);
    const y = normalizeMatchText(b.text);
    if (!x || !y) return false;
    // Either side may still have a short user-echo prefix
    if (x.endsWith(y) || y.endsWith(x)) {
      const longer = x.length >= y.length ? x : y;
      const shorter = x.length >= y.length ? y : x;
      // require substantial overlap (not a trivial suffix)
      if (shorter.length >= 12 && longer.length - shorter.length <= 80) return true;
    }
    // Shared long suffix after stripping non-alnum noise
    const ax = x.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    const ay = y.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    if (ax.length >= 20 && ay.length >= 20 && (ax.endsWith(ay) || ay.endsWith(ax))) {
      return true;
    }
  }
  return false;
}

export type HistoryReconcileMode = "strict" | "stateful";

/**
 * Reconcile client messages against agent history.
 *
 * **strict** — stored history must be a prefix of incoming (classic OpenAI
 * clients that resend the full transcript correctly).
 *
 * **stateful** (default for agent mounts) — try strict first; on mismatch,
 * treat the **last user message** in the request as the new turn. Durable
 * agent history lives on the server + WebUI; harnesses (Pi) often resend a
 * different/truncated client transcript and must not hard-fail multi-turn.
 */
export function reconcileHistoryPrefix(
  agentHistory: NormalizedMessage[],
  incoming: ComparableMessage[],
  agentId: AgentId,
  mode: HistoryReconcileMode = "stateful",
): { prefixLen: number; suffix: ComparableMessage[]; modeUsed: HistoryReconcileMode } {
  try {
    const r = reconcileHistoryStrict(agentHistory, incoming, agentId);
    // Empty suffix = client resent a transcript that already matches history.
    // After a failed generation the provisional user row may still be stored
    // (no assistant after it). Allow re-drive of that last user so Pi retries work.
    if (r.suffix.length === 0) {
      const lastStored = agentHistory[agentHistory.length - 1];
      const lastIncomingUser = [...incoming].reverse().find((m) => m.role === "user");
      if (
        lastStored?.role === "user" &&
        lastIncomingUser &&
        messagesMatch(comparableFromNormalized(lastStored), lastIncomingUser)
      ) {
        return {
          prefixLen: Math.max(0, agentHistory.length - 1),
          suffix: [lastIncomingUser],
          modeUsed: "stateful",
        };
      }
      throw err("invalid_request", "No new messages after history reconciliation", 400, {
        agentId,
      });
    }
    return { ...r, modeUsed: "strict" };
  } catch (e) {
    if (mode === "strict") throw e;
    // Genuine "nothing new" must stay 400 — do not re-fire last user forever.
    if (e instanceof AifrostException && e.error.code === "invalid_request") {
      throw e;
    }
    // Fall through to stateful (history drift / prefix mismatch)
  }

  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.text.trim()) {
    throw err(
      "agent_history_conflict",
      "Cannot reconcile history and no user message found for stateful continue",
      409,
      {
        agentId,
        details: {
          stored_len: agentHistory.length,
          incoming_len: incoming.length,
          mode: "stateful",
        },
      },
    );
  }

  // Avoid re-submitting the exact last stored user (no-op / loop)
  const stored = agentHistory.map(comparableFromNormalized);
  const lastStoredUser = [...stored].reverse().find((m) => m.role === "user");
  if (
    lastStoredUser &&
    messagesMatch(lastStoredUser, lastUser) &&
    incoming.filter((m) => m.role === "user").length === 1
  ) {
    // Client only resent the same single user line — treat as new if it's the
    // only content and history already has assistant after it, still submit
    // only if there's a newer user... with one user matching last, suffix empty.
    const onlySame =
      stored.length > 0 && messagesMatch(stored[stored.length - 1]!, lastUser) === false;
    void onlySame;
  }

  // If last incoming user equals last stored user and there's no newer content,
  // suffix would be empty — still allow if last stored is assistant (client
  // retry of same user after failure). Prefer last user always as new turn
  // unless it exactly equals the last history user AND history ends with assistant
  // and client has no extra messages after... Simpler: always use last user as
  // the new turn text in stateful fallback (WebUI gets one new composer submit).
  return {
    prefixLen: 0,
    suffix: [lastUser],
    modeUsed: "stateful",
  };
}

function reconcileHistoryStrict(
  agentHistory: NormalizedMessage[],
  incoming: ComparableMessage[],
  agentId: AgentId,
): { prefixLen: number; suffix: ComparableMessage[] } {
  const stored = agentHistory.map(comparableFromNormalized);
  let ii = 0;

  for (let si = 0; si < stored.length; si++) {
    if (ii >= incoming.length) {
      throw err(
        "agent_history_conflict",
        "Request messages are shorter than agent history; cannot reconcile",
        409,
        {
          agentId,
          details: {
            stored_len: stored.length,
            incoming_len: incoming.length,
            stored_index: si,
          },
        },
      );
    }

    const s = stored[si]!;
    const inc = incoming[ii]!;

    if (messagesMatch(s, inc)) {
      ii += 1;
      continue;
    }

    // Stored user == join(incoming[ii..j]) of consecutive users
    if (s.role === "user" && inc.role === "user") {
      let acc = inc.text;
      let j = ii;
      let matched = false;
      while (j + 1 < incoming.length && incoming[j + 1]!.role === "user") {
        j += 1;
        acc = `${acc}\n\n${incoming[j]!.text}`;
        if (acc === s.text || normalizeMatchText(acc) === normalizeMatchText(s.text)) {
          ii = j + 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    throw err("agent_history_conflict", `Message history diverges at index ${si}`, 409, {
      agentId,
      details: {
        index: si,
        stored: { role: s.role, text: s.text.slice(0, 200) },
        incoming: { role: inc.role, text: inc.text.slice(0, 200) },
      },
    });
  }

  return {
    prefixLen: ii,
    suffix: incoming.slice(ii),
  };
}

export function openaiMessageToNormalized(
  msg: { role?: unknown; content?: unknown },
  agentId: AgentId,
  id?: MessageId,
): NormalizedMessage {
  const roleRaw = String(msg.role ?? "user");
  const role = normalizeRole(roleRaw);
  return {
    id: id ?? newMessageId(),
    agentId,
    providerMessageId: null,
    role,
    content: [textContent(openaiContentToText(msg.content))],
    createdAt: new Date().toISOString(),
    metadata: {},
  };
}

function normalizeRole(role: string): NormalizedMessage["role"] {
  switch (role) {
    case "system":
    case "developer":
    case "user":
    case "assistant":
    case "tool":
      return role;
    default:
      return "user";
  }
}

/**
 * Build turn text from reconciled suffix.
 * - Assistant in suffix is a conflict (client inventing turns we do not have).
 * - All user messages in the suffix are joined with `\n\n` (safety net;
 *   projection already coalesces consecutive users for history stability).
 * - system/developer in suffix are ignored for WebUI submit (harness-owned;
 *   only user text is typed into the composer).
 */
export function suffixToNewTurnMessages(
  suffix: ComparableMessage[],
  agentId: AgentId,
): NormalizedMessage[] {
  if (suffix.length === 0) {
    throw err("invalid_request", "No new messages after history reconciliation", 400, { agentId });
  }

  for (const m of suffix) {
    if (m.role === "assistant") {
      throw err(
        "agent_history_conflict",
        "Suffix includes assistant messages not present in agent history",
        409,
        { agentId },
      );
    }
  }

  const users = suffix.filter((m) => m.role === "user");
  if (users.length === 0) {
    throw err("invalid_request", "New messages must include at least one user message", 400, {
      agentId,
    });
  }

  // Tool observations: join consecutive [tool_result …] users (parallel tools).
  // Plain chat: use ONLY the last user message. Joining all plain users dumps
  // Pi retries ("hello?", "hello?", "test") into one ChatGPT prompt and poisons
  // history + capture.
  //
  // CRITICAL: when the suffix includes tool results, submit ONLY those.
  // The original user request already lives in the ChatGPT WebUI transcript
  // (and was PE-wrapped on the prior turn). Re-pasting it + a multi-MB
  // find/ls dump hangs CDP Runtime.evaluate and confuses the model.
  const isToolObs = (t: string) => t.startsWith("[tool_result");
  const toolUsers = users.filter((u) => isToolObs(u.text));
  const plainUsers = users.filter((u) => !isToolObs(u.text));

  let text: string;
  if (toolUsers.length > 0) {
    text = toolUsers
      .map((u) => u.text)
      .filter((t) => t.length > 0)
      .join("\n\n");
  } else {
    text = plainUsers[plainUsers.length - 1]!.text;
  }

  if (!text.trim()) {
    throw err("invalid_request", "New user message text is empty after projection", 400, {
      agentId,
    });
  }

  return [
    {
      id: newMessageId(),
      agentId,
      providerMessageId: null,
      role: "user",
      content: [textContent(text)],
      createdAt: new Date().toISOString(),
      metadata: {},
    },
  ];
}

/**
 * @deprecated Use stripClientToolParams from project-messages.ts.
 * Kept as a thin alias for any external imports during transition.
 */
export function rejectUnsupportedTools(body: Record<string, unknown>): void {
  // No-op reject path removed: tools are stripped, not rejected.
  // Import stripClientToolParams in new code.
  void body;
}

/** Model is a label only — never mutates agent settings. */
export function modelLabelForAgent(agent: Agent, requestedModel?: unknown): string {
  const effective = agent.settings.effective.model_or_mode;
  if (typeof effective === "string" && effective.length > 0) {
    return effective;
  }
  if (typeof requestedModel === "string" && requestedModel.length > 0) {
    return requestedModel;
  }
  return agent.providerId;
}

export function listModelsResponse(agent: Agent): ProtocolHttpResponse {
  const id = modelLabelForAgent(agent);
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      object: "list",
      data: [
        {
          id,
          object: "model",
          created: Math.floor(Date.parse(agent.createdAt) / 1000) || 0,
          owned_by: "aifrost",
        },
      ],
    },
  };
}

export function encodeOpenAIError(error: AifrostError, httpStatus: number): ProtocolHttpResponse {
  const type =
    httpStatus === 401
      ? "authentication_error"
      : httpStatus === 404
        ? "invalid_request_error"
        : httpStatus === 409
          ? "invalid_request_error"
          : httpStatus === 422
            ? "invalid_request_error"
            : httpStatus >= 500
              ? "server_error"
              : "invalid_request_error";

  return {
    status: httpStatus,
    headers: { "content-type": "application/json" },
    body: {
      error: {
        message: error.message,
        type,
        code: error.code,
        param:
          error.details &&
          typeof error.details === "object" &&
          error.details !== null &&
          "param" in error.details
            ? (error.details as { param: unknown }).param
            : null,
        aifrost: {
          code: error.code,
          retryable: error.retryable,
          agent_id: error.agentId ?? null,
          generation_id: error.generationId ?? null,
          usage_available: false,
        },
      },
    },
  };
}

export function aifrostErrorHttpStatus(error: AifrostError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "agent_not_found":
      return 404;
    case "agent_history_conflict":
    case "agent_configuration_conflict":
    case "agent_busy":
    case "settings_revision_conflict":
      return 409;
    case "unsupported_parameter":
    case "invalid_request":
      return error.code === "unsupported_parameter" ? 422 : 400;
    case "agent_unavailable":
    case "provider_unsupported_by_runtime":
      return 503;
    case "rate_limited":
      return 429;
    case "tool_scaffold_incomplete":
      return 503;
    default:
      return 500;
  }
}

export function baseCanonicalRequest(
  agent: Agent,
  sourceProtocol: string,
  opts: {
    newTurnMessages: NormalizedMessage[];
    history: NormalizedMessage[];
    stream: boolean;
    metadata?: Record<string, unknown>;
    generationId?: GenerationId;
    tools?: CanonicalGenerationRequest["tools"];
  },
): CanonicalGenerationRequest {
  return {
    agentId: agent.id,
    generationId: opts.generationId ?? newGenerationId(),
    sourceProtocol,
    messages: [...opts.history, ...opts.newTurnMessages],
    newTurnMessages: opts.newTurnMessages,
    stream: opts.stream,
    requestedSettings: {},
    tools: opts.tools ?? [],
    responseFormat: null,
    metadata: opts.metadata ?? {},
  };
}

export function turnInputFromRequest(request: CanonicalGenerationRequest): {
  input: Array<{ type: "input_text"; text: string }>;
  stream: boolean;
  metadata?: Record<string, unknown>;
  protocol: string;
  tools?: CanonicalGenerationRequest["tools"];
} {
  const text = request.newTurnMessages.map((m) => extractPlainText(m)).join("\n");
  return {
    input: [{ type: "input_text", text }],
    stream: request.stream,
    metadata: {
      ...request.metadata,
      client_tools: request.tools,
    },
    protocol: request.sourceProtocol,
    tools: request.tools,
  };
}

export function assistantTextFromMessages(messages: NormalizedMessage[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) => extractPlainText(m))
    .join("");
}
