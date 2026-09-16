/**
 * Minimal OpenAI Responses API protocol adapter.
 * Consumes only canonical events — no provider DOM/network logic.
 */

import type { Agent } from "../../types/agent.js";
import type { ProviderCapabilities } from "../../types/capabilities.js";
import type { AifrostError } from "../../types/errors.js";
import { err } from "../../types/errors.js";
import type { CanonicalGenerationEvent } from "../../types/events.js";
import type {
  CanonicalGenerationRequest,
  CanonicalGenerationResult,
} from "../../types/generation.js";
import type { NormalizedMessage } from "../../types/messages.js";
import { textContent } from "../../types/messages.js";
import { newMessageId } from "../../types/ids.js";
import type {
  InferenceProtocolAdapter,
  ProtocolHttpRequest,
  ProtocolHttpResponse,
} from "../contract.js";
import {
  aifrostErrorHttpStatus,
  assistantTextFromMessages,
  baseCanonicalRequest,
  encodeOpenAIError,
  encodeUtf8,
  modelLabelForAgent,
  openaiContentToText,
} from "./shared.js";
import { stripClientToolParams, truncateToolPayload } from "./project-messages.js";
import { extractClientToolDefinitions, toolIntentsToOpenAIToolCalls } from "./tool-intents.js";

export const OPENAI_RESPONSES_PROTOCOL = "openai.responses";

export interface ResponsesParseOptions {
  history: NormalizedMessage[];
  generationId?: CanonicalGenerationRequest["generationId"];
}

/**
 * Parse a minimal OpenAI Responses request into a canonical generation request.
 * Responses clients typically send only new input (not full chat history).
 * previous_response_id is accepted as metadata only for the same agent.
 */
export function parseResponsesRequest(
  body: unknown,
  agent: Agent,
  opts: ResponsesParseOptions,
): CanonicalGenerationRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw err("invalid_request", "Request body must be a JSON object", 400, {
      agentId: agent.id,
    });
  }
  const b = { ...(body as Record<string, unknown>) };
  // Capture tools for the prompt-engineered tool_calls façade before strip
  // removes the definitions (same mechanism as chat.completions — AIFROST_TOOL).
  const clientTools = extractClientToolDefinitions(b);
  stripClientToolParams(b);

  // previous_response_id is protocol-level only — must not invent history forks
  if (b.previous_response_id != null && typeof b.previous_response_id !== "string") {
    throw err("invalid_request", "previous_response_id must be a string", 400, {
      agentId: agent.id,
      details: { param: "previous_response_id" },
    });
  }

  const userText = extractResponsesInputText(b.input, agent);
  if (!userText.trim()) {
    throw err("invalid_request", "input must contain text", 400, {
      agentId: agent.id,
      details: { param: "input" },
    });
  }

  // instructions (system-like) — accepted as metadata; not applied as settings
  if (b.instructions != null && typeof b.instructions !== "string") {
    throw err("invalid_request", "instructions must be a string", 400, {
      agentId: agent.id,
      details: { param: "instructions" },
    });
  }

  const newTurnMessages: NormalizedMessage[] = [
    {
      id: newMessageId(),
      agentId: agent.id,
      providerMessageId: null,
      role: "user",
      content: [textContent(userText)],
      createdAt: new Date().toISOString(),
      metadata: {},
    },
  ];

  const stream = Boolean(b.stream);
  const model = modelLabelForAgent(agent, b.model);

  return baseCanonicalRequest(agent, OPENAI_RESPONSES_PROTOCOL, {
    newTurnMessages,
    history: opts.history,
    stream,
    generationId: opts.generationId,
    tools: clientTools,
    metadata: {
      openai: {
        model_label: model,
        requested_model: typeof b.model === "string" ? b.model : null,
        previous_response_id:
          typeof b.previous_response_id === "string" ? b.previous_response_id : null,
        instructions: typeof b.instructions === "string" ? b.instructions : null,
      },
    },
  });
}

function extractResponsesInputText(input: unknown, agent: Agent): string {
  if (input == null) {
    throw err("invalid_request", "input is required", 400, {
      agentId: agent.id,
      details: { param: "input" },
    });
  }
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    const parts: string[] = [];
    for (const item of input) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      // function_call_output → projected tool-result observation (same shape
      // chat.completions uses for role:"tool" messages).
      if (obj.type === "function_call_output") {
        const callId = typeof obj.call_id === "string" && obj.call_id ? obj.call_id : null;
        const out =
          typeof obj.output === "string"
            ? obj.output
            : obj.output != null
              ? JSON.stringify(obj.output)
              : "";
        const header = callId ? `[tool_result id=${callId}]` : "[tool_result]";
        const bodyText = truncateToolPayload(out);
        parts.push(bodyText ? `${header}\n${bodyText}` : header);
        continue;
      }
      // function_call items are the assistant's own harness-local intents
      // replayed by the client — never part of the WebUI transcript.
      if (obj.type === "function_call") {
        continue;
      }
      // message item
      if (obj.type === "message" || obj.role != null) {
        if (Array.isArray(obj.content) || typeof obj.content === "string") {
          parts.push(openaiContentToText(obj.content));
        } else if (typeof obj.content === "undefined" && typeof obj.text === "string") {
          parts.push(obj.text);
        }
        continue;
      }
      // input_text item
      if (obj.type === "input_text" && typeof obj.text === "string") {
        parts.push(obj.text);
        continue;
      }
      if (obj.type === "input_image" || obj.type === "input_file") {
        throw err(
          "unsupported_parameter",
          `Input item type ${String(obj.type)} is not supported`,
          422,
          { agentId: agent.id, details: { param: "input" } },
        );
      }
      if (typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
    return parts.join("");
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    return openaiContentToText(obj.content);
  }
  throw err("invalid_request", "input must be a string or array", 400, {
    agentId: agent.id,
    details: { param: "input" },
  });
}

export function encodeResponse(
  result: CanonicalGenerationResult,
  opts: { model: string; created?: number },
): ProtocolHttpResponse {
  const text = assistantTextFromMessages(result.messages);
  const id = responseId(result.generationId);
  const createdAt = opts.created ?? Math.floor(Date.now() / 1000);
  const status = result.cancelled ? "cancelled" : "completed";

  const outputMessage = {
    id: `msg_${result.generationId.replace(/^gen_/, "")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };

  // Prompt-engineered tool intents → Responses function_call output items.
  const toolCalls = toolIntentsToOpenAIToolCalls(result.toolIntents ?? []);
  const output = result.cancelled
    ? []
    : toolCalls.length > 0
      ? toolCalls.map((tc) => functionCallItem(tc))
      : [outputMessage];

  const body: Record<string, unknown> = {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    model: opts.model,
    output,
    // Never fabricate token usage
    usage: null,
    usage_available: false,
    parallel_tool_calls: false,
    tools: [],
    temperature: null,
    top_p: null,
    metadata: {},
  };

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
  };
}

/**
 * Map canonical events to a minimal OpenAI Responses SSE stream.
 * Event format: event: <type>\ndata: <json>\n\n
 */
export async function* encodeResponseStream(
  events: AsyncIterable<CanonicalGenerationEvent>,
  opts: { model: string; generationId?: string },
): AsyncIterable<Uint8Array> {
  let id = opts.generationId ? responseId(opts.generationId) : "";
  const createdAt = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  const contentIndex = 0;
  let sequence = 0;
  let started = false;
  let textStarted = false;

  const emit = (event: string, data: unknown): Uint8Array => {
    sequence += 1;
    const payload =
      data && typeof data === "object" ? { ...(data as object), sequence_number: sequence } : data;
    return encodeUtf8(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  for await (const ev of events) {
    if (ev.type === "generation.created") {
      if (!id) id = responseId(ev.generationId);
      started = true;
      yield emit("response.created", {
        type: "response.created",
        response: skeletonResponse(id, opts.model, createdAt, "in_progress"),
      });
      yield emit("response.in_progress", {
        type: "response.in_progress",
        response: skeletonResponse(id, opts.model, createdAt, "in_progress"),
      });
      continue;
    }

    if (ev.type === "generation.started") {
      if (!id) id = responseId(ev.generationId);
      if (!started) {
        started = true;
        yield emit("response.created", {
          type: "response.created",
          response: skeletonResponse(id, opts.model, createdAt, "in_progress"),
        });
      }
      continue;
    }

    if (ev.type === "output_text.delta") {
      if (!id) id = responseId(ev.generationId);
      if (!textStarted) {
        textStarted = true;
        yield emit("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            id: `msg_${id.replace(/^resp_/, "")}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        });
        yield emit("response.content_part.added", {
          type: "response.content_part.added",
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      yield emit("response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: outputIndex,
        content_index: contentIndex,
        delta: ev.delta,
      });
      continue;
    }

    if (ev.type === "generation.completed") {
      if (!id) id = responseId(ev.generationId);
      const text = assistantTextFromMessages(ev.messages);
      const toolCalls = toolIntentsToOpenAIToolCalls(ev.toolIntents ?? []);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const item = functionCallItem(tc);
          yield emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...item, arguments: "", status: "in_progress" },
          });
          // Arguments are emitted in one delta — Aifrost does not stream
          // partial tokens; the model emits the full AIFROST_TOOL block.
          yield emit("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            output_index: outputIndex,
            item_id: item.id,
            delta: tc.function.arguments,
          });
          yield emit("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            output_index: outputIndex,
            item_id: item.id,
            arguments: tc.function.arguments,
          });
          yield emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          });
          outputIndex += 1;
        }
      } else if (textStarted) {
        yield emit("response.output_text.done", {
          type: "response.output_text.done",
          output_index: outputIndex,
          content_index: contentIndex,
          text,
        });
        yield emit("response.content_part.done", {
          type: "response.content_part.done",
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: "output_text", text, annotations: [] },
        });
        yield emit("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: {
            id: `msg_${id.replace(/^resp_/, "")}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        });
      }
      const completed = encodeResponse(
        {
          generationId: ev.generationId,
          messages: ev.messages,
          toolIntents: ev.toolIntents,
        },
        { model: opts.model, created: createdAt },
      ).body;
      yield emit("response.completed", {
        type: "response.completed",
        response: completed,
      });
      break;
    }

    if (ev.type === "generation.cancelled") {
      if (!id) id = responseId(ev.generationId);
      yield emit("response.completed", {
        type: "response.completed",
        response: skeletonResponse(id, opts.model, createdAt, "cancelled"),
      });
      break;
    }

    if (ev.type === "generation.failed") {
      yield emit("response.failed", {
        type: "response.failed",
        response: {
          ...skeletonResponse(id || "resp_unknown", opts.model, createdAt, "failed"),
          error: {
            code: ev.error.code,
            message: ev.error.message,
          },
        },
      });
      break;
    }
  }
}

export function encodeResponsesError(error: AifrostError): ProtocolHttpResponse {
  return encodeOpenAIError(error, aifrostErrorHttpStatus(error));
}

function responseId(generationId: string): string {
  const bare = generationId.startsWith("gen_") ? generationId.slice(4) : generationId;
  return `resp_${bare}`;
}

/** Responses-API function_call output item from an OpenAI-style tool call. */
function functionCallItem(tc: {
  id: string;
  function: { name: string; arguments: string };
}): Record<string, unknown> {
  return {
    id: `fc_${tc.id.replace(/^call_/, "")}`,
    type: "function_call",
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
    status: "completed",
  };
}

function skeletonResponse(
  id: string,
  model: string,
  createdAt: number,
  status: string,
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    model,
    output: [],
    usage: null,
    usage_available: false,
    tools: [],
    metadata: {},
  };
}

/**
 * InferenceProtocolAdapter implementation for OpenAI Responses.
 * History is injected via `setHistory` before `parseRequest` (append semantics).
 */
export class OpenAIResponsesAdapter implements InferenceProtocolAdapter {
  readonly id = OPENAI_RESPONSES_PROTOCOL;
  private history: NormalizedMessage[] = [];
  private lastModel = "aifrost";

  setHistory(history: NormalizedMessage[]): this {
    this.history = history;
    return this;
  }

  async parseRequest(http: ProtocolHttpRequest, agent: Agent): Promise<CanonicalGenerationRequest> {
    const req = parseResponsesRequest(http.body, agent, {
      history: this.history,
    });
    this.lastModel = modelLabelForAgent(agent, (http.body as { model?: unknown } | null)?.model);
    return req;
  }

  validate(_request: CanonicalGenerationRequest, _capabilities: ProviderCapabilities): void {
    // Tools already rejected at parse time when unsupported.
  }

  encodeNonStreaming(result: CanonicalGenerationResult): ProtocolHttpResponse {
    return encodeResponse(result, { model: this.lastModel });
  }

  async *encodeStreaming(
    events: AsyncIterable<CanonicalGenerationEvent>,
  ): AsyncIterable<Uint8Array> {
    yield* encodeResponseStream(events, { model: this.lastModel });
  }

  encodeError(error: AifrostError): ProtocolHttpResponse {
    return encodeResponsesError(error);
  }
}
