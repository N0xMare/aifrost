/**
 * OpenAI protocol registry helpers.
 */

import type { InferenceProtocolAdapter } from "../contract.js";
import {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL,
  OpenAIChatCompletionsAdapter,
} from "./chat-completions.js";
import { OPENAI_RESPONSES_PROTOCOL, OpenAIResponsesAdapter } from "./responses.js";

export {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL,
  OpenAIChatCompletionsAdapter,
  parseChatCompletionsRequest,
  encodeChatCompletion,
  encodeChatCompletionStream,
  encodeChatCompletionsError,
} from "./chat-completions.js";

export {
  OPENAI_RESPONSES_PROTOCOL,
  OpenAIResponsesAdapter,
  parseResponsesRequest,
  encodeResponse,
  encodeResponseStream,
  encodeResponsesError,
} from "./responses.js";

export {
  encodeOpenAIError,
  listModelsResponse,
  modelLabelForAgent,
  reconcileHistoryPrefix,
  rejectUnsupportedTools,
  turnInputFromRequest,
  aifrostErrorHttpStatus,
} from "./shared.js";

export {
  stripClientToolParams,
  projectOpenAIMessages,
  projectOpenAIMessage,
  truncateToolPayload,
  TOOL_PAYLOAD_MAX_CHARS,
} from "./project-messages.js";

export {
  extractClientToolDefinitions,
  toolIntentsToOpenAIToolCalls,
  planFixtureToolIntents,
  tryParseToolScaffold,
  newToolCallId,
  wrapUserTextForHarnessTools,
  buildHarnessToolInstruction,
} from "./tool-intents.js";

export {
  resolveHarnessProtocolMode,
  encodeToolCatalogToon,
  buildStickyProtocolV1,
  composeHarnessTurnV1,
  toolCatalogFingerprint,
  measureHarnessWrap,
  stripHarnessPeEcho,
} from "./harness-protocol.js";

export {
  planHarnessToolIntents,
  looksLikePureChat,
  resolveHarnessToolsMode,
} from "./harness-tools.js";

export type OpenAIProtocolId =
  typeof OPENAI_CHAT_COMPLETIONS_PROTOCOL | typeof OPENAI_RESPONSES_PROTOCOL;

const adapters: Record<string, () => InferenceProtocolAdapter> = {
  [OPENAI_CHAT_COMPLETIONS_PROTOCOL]: () => new OpenAIChatCompletionsAdapter(),
  [OPENAI_RESPONSES_PROTOCOL]: () => new OpenAIResponsesAdapter(),
  // Friendly aliases
  "chat.completions": () => new OpenAIChatCompletionsAdapter(),
  responses: () => new OpenAIResponsesAdapter(),
};

export function createOpenAIAdapter(id: string): InferenceProtocolAdapter {
  const factory = adapters[id];
  if (!factory) {
    throw new Error(`Unknown OpenAI protocol adapter: ${id}`);
  }
  return factory();
}

export function listOpenAIProtocols(): Array<{ id: string; description: string }> {
  return [
    {
      id: OPENAI_CHAT_COMPLETIONS_PROTOCOL,
      description: "OpenAI Chat Completions (/v1/chat/completions)",
    },
    {
      id: OPENAI_RESPONSES_PROTOCOL,
      description: "OpenAI Responses (/v1/responses)",
    },
  ];
}

export function isOpenAIProtocol(id: string): boolean {
  return id in adapters;
}
