/**
 * OpenAI Chat Completions protocol adapter.
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
  encodeSseData,
  encodeSseDone,
  modelLabelForAgent,
  openaiContentToText,
  reconcileHistoryPrefix,
  suffixToNewTurnMessages,
} from "./shared.js";
import {
  projectOpenAIMessages,
  stripClientToolParams,
  type OpenAIMessageLike,
} from "./project-messages.js";
import { extractClientToolDefinitions, toolIntentsToOpenAIToolCalls } from "./tool-intents.js";

export const OPENAI_CHAT_COMPLETIONS_PROTOCOL = "openai.chat.completions";

export interface ChatCompletionsParseOptions {
  history: NormalizedMessage[];
  /** Optional pre-assigned generation id (tests / wiring). */
  generationId?: CanonicalGenerationRequest["generationId"];
}

/**
 * Parse an OpenAI chat.completions body into a canonical generation request.
 * Performs history reconciliation against the agent's stored messages.
 */
export function parseChatCompletionsRequest(
  body: unknown,
  agent: Agent,
  opts: ChatCompletionsParseOptions,
): CanonicalGenerationRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw err("invalid_request", "Request body must be a JSON object", 400, {
      agentId: agent.id,
    });
  }
  // Copy so strip does not mutate caller-owned bodies (tests / inject reuse).
  const b = { ...(body as Record<string, unknown>) };
  // Capture tools for emulated tool_calls before strip removes definitions.
  const clientTools = extractClientToolDefinitions(b);
  stripClientToolParams(b);

  if (!Array.isArray(b.messages)) {
    throw err("invalid_request", "messages must be an array", 400, {
      agentId: agent.id,
      details: { param: "messages" },
    });
  }

  const rawMessages = b.messages as unknown[];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!m || typeof m !== "object") {
      throw err("invalid_request", `messages[${i}] must be an object`, 400, {
        agentId: agent.id,
      });
    }
    const msg = m as { content?: unknown };
    // Reject non-text content parts that we cannot represent
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "image_url" || p.type === "input_image" || p.type === "image") {
            throw err("unsupported_parameter", "Image content parts are not supported", 422, {
              agentId: agent.id,
              details: { param: "messages.content" },
            });
          }
        }
      }
    }
  }

  // Project tool_calls / role:tool into deterministic text before reconcile.
  const incoming = projectOpenAIMessages(rawMessages as OpenAIMessageLike[]);

  // Agent-scoped mounts are stateful: default reconcile is "stateful" so Pi
  // (and other harnesses) keep working when their client transcript drifts.
  // Set AIFROST_HISTORY_MODE=strict for OpenAI-classic hard prefix matching.
  const histMode = process.env.AIFROST_HISTORY_MODE === "strict" ? "strict" : "stateful";
  const { suffix, modeUsed } = reconcileHistoryPrefix(opts.history, incoming, agent.id, histMode);
  const newTurnMessages = suffixToNewTurnMessages(suffix, agent.id);

  const stream = Boolean(b.stream);

  // model is label-only — never applied as a settings mutation
  const model = modelLabelForAgent(agent, b.model);

  return baseCanonicalRequest(agent, OPENAI_CHAT_COMPLETIONS_PROTOCOL, {
    newTurnMessages,
    history: opts.history,
    stream,
    generationId: opts.generationId,
    tools: clientTools,
    metadata: {
      openai: {
        model_label: model,
        requested_model: typeof b.model === "string" ? b.model : null,
      },
      history_reconcile: modeUsed,
      ...(typeof b.user === "string" ? { user: b.user } : {}),
    },
  });
}

export function encodeChatCompletion(
  result: CanonicalGenerationResult,
  opts: { model: string; created?: number },
): ProtocolHttpResponse {
  const content = assistantTextFromMessages(result.messages);
  const id = chatCompletionId(result.generationId);
  const intents = result.toolIntents ?? [];
  const useTools = !result.cancelled && intents.length > 0;

  const message: Record<string, unknown> = useTools
    ? {
        role: "assistant",
        content: content.trim() ? content : null,
        tool_calls: toolIntentsToOpenAIToolCalls(intents),
        refusal: null,
      }
    : {
        role: "assistant",
        content: result.cancelled ? null : content,
        refusal: null,
      };

  const body: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.cancelled ? "stop" : useTools ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    // Never fabricate token usage
    usage: null,
    usage_available: false,
  };

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
  };
}

/**
 * Map canonical generation events to OpenAI chat.completion.chunk SSE bytes.
 */
export async function* encodeChatCompletionStream(
  events: AsyncIterable<CanonicalGenerationEvent>,
  opts: { model: string; generationId?: string },
): AsyncIterable<Uint8Array> {
  let id = opts.generationId ? chatCompletionId(opts.generationId) : "";
  let roleSent = false;
  const created = Math.floor(Date.now() / 1000);
  let finished = false;

  for await (const ev of events) {
    if (ev.type === "generation.created" || ev.type === "generation.started") {
      if (!id) id = chatCompletionId(ev.generationId);
      if (!roleSent) {
        roleSent = true;
        yield encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
              logprobs: null,
            },
          ],
          usage: null,
          usage_available: false,
        });
      }
      continue;
    }

    if (ev.type === "output_text.delta") {
      if (!id) id = chatCompletionId(ev.generationId);
      if (!roleSent) {
        roleSent = true;
        yield encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
              logprobs: null,
            },
          ],
          usage: null,
          usage_available: false,
        });
      }
      yield encodeSseData({
        id,
        object: "chat.completion.chunk",
        created,
        model: opts.model,
        choices: [
          {
            index: 0,
            delta: { content: ev.delta },
            finish_reason: null,
            logprobs: null,
          },
        ],
        usage: null,
        usage_available: false,
      });
      continue;
    }

    if (ev.type === "generation.completed") {
      if (!id) id = chatCompletionId(ev.generationId);
      const intents = ev.toolIntents ?? [];
      if (intents.length > 0) {
        if (!roleSent) {
          roleSent = true;
          yield encodeSseData({
            id,
            object: "chat.completion.chunk",
            created,
            model: opts.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: null },
                finish_reason: null,
                logprobs: null,
              },
            ],
            usage: null,
            usage_available: false,
          });
        }
        const toolCalls = toolIntentsToOpenAIToolCalls(intents);
        yield encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: toolCalls.map((tc, index) => ({
                  index,
                  id: tc.id,
                  type: tc.type,
                  function: tc.function,
                })),
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
          usage: null,
          usage_available: false,
        });
        yield encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          usage: null,
          usage_available: false,
        });
      } else {
        yield encodeSseData({
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: null,
          usage_available: false,
        });
      }
      finished = true;
      break;
    }

    if (ev.type === "generation.cancelled") {
      if (!id) id = chatCompletionId(ev.generationId);
      yield encodeSseData({
        id,
        object: "chat.completion.chunk",
        created,
        model: opts.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: null,
        usage_available: false,
      });
      finished = true;
      break;
    }

    if (ev.type === "generation.failed") {
      yield encodeSseData({
        error: {
          message: ev.error.message,
          type: "server_error",
          code: ev.error.code,
        },
      });
      finished = true;
      break;
    }

    // Ignore reasoning, citations, tools, snapshots for minimal chat surface
  }

  if (!finished && id) {
    yield encodeSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: null,
      usage_available: false,
    });
  }

  yield encodeSseDone();
}

export function encodeChatCompletionsError(error: AifrostError): ProtocolHttpResponse {
  return encodeOpenAIError(error, aifrostErrorHttpStatus(error));
}

function chatCompletionId(generationId: string): string {
  const bare = generationId.startsWith("gen_") ? generationId.slice(4) : generationId;
  return `chatcmpl_${bare}`;
}

/**
 * InferenceProtocolAdapter implementation for Chat Completions.
 * History must be injected via `setHistory` before `parseRequest`.
 */
export class OpenAIChatCompletionsAdapter implements InferenceProtocolAdapter {
  readonly id = OPENAI_CHAT_COMPLETIONS_PROTOCOL;
  private history: NormalizedMessage[] = [];
  private lastModel = "aifrost";

  setHistory(history: NormalizedMessage[]): this {
    this.history = history;
    return this;
  }

  async parseRequest(http: ProtocolHttpRequest, agent: Agent): Promise<CanonicalGenerationRequest> {
    const req = parseChatCompletionsRequest(http.body, agent, {
      history: this.history,
    });
    this.lastModel = modelLabelForAgent(agent, (http.body as { model?: unknown } | null)?.model);
    return req;
  }

  validate(_request: CanonicalGenerationRequest, capabilities: ProviderCapabilities): void {
    if (capabilities.protocolFidelity.arbitraryFunctionTools === "unsupported") {
      // Client tools are stripped + projected at parse; never executed in WebUI.
      void capabilities;
    }
  }

  encodeNonStreaming(result: CanonicalGenerationResult): ProtocolHttpResponse {
    return encodeChatCompletion(result, { model: this.lastModel });
  }

  async *encodeStreaming(
    events: AsyncIterable<CanonicalGenerationEvent>,
  ): AsyncIterable<Uint8Array> {
    yield* encodeChatCompletionStream(events, { model: this.lastModel });
  }

  encodeError(error: AifrostError): ProtocolHttpResponse {
    return encodeChatCompletionsError(error);
  }
}

/** Test helper: extract text for golden fixtures. */
export function debugContentText(content: unknown): string {
  return openaiContentToText(content);
}
