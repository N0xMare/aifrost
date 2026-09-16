import type { AgentId, GenerationId, MessageId } from "./ids.js";
import type { NormalizedMessage } from "./messages.js";

export interface CanonicalToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
  /** client_function tools are not the same as provider built-ins */
  kind: "client_function" | "provider_builtin" | "unknown";
}

/**
 * Provider/protocol-owned tool request (OpenAI tool_calls façade).
 * Produced by code (fixture policy, parsers) — not by raw WebUI hope.
 */
export interface CanonicalToolIntent {
  /** Stable id for the call (OpenAI call_… style). */
  id: string;
  name: string;
  /** JSON object or JSON string; encoded as string on the OpenAI wire. */
  arguments: Record<string, unknown> | string;
}

export interface CanonicalGenerationRequest {
  agentId: AgentId;
  generationId: GenerationId;
  sourceProtocol: string;
  messages: NormalizedMessage[];
  newTurnMessages: NormalizedMessage[];
  stream: boolean;
  requestedSettings: Record<string, unknown>;
  tools: CanonicalToolDefinition[];
  responseFormat: unknown | null;
  metadata: Record<string, unknown>;
}

export interface CanonicalGenerationResult {
  generationId: GenerationId;
  messages: NormalizedMessage[];
  usage?: unknown;
  cancelled?: boolean;
  /**
   * When set (and messages empty or without assistant text), OpenAI encoder
   * emits tool_calls instead of content. Harness runs tools and continues.
   */
  toolIntents?: CanonicalToolIntent[];
}

export interface ProviderConversationRef {
  providerConversationId?: string;
  providerUrl?: string;
}

export interface ObservedAgentState {
  auth: "unknown" | "authenticated" | "expired" | "login_required";
  conversation: ProviderConversationRef & {
    title?: string | null;
    turnCount?: number;
  };
  settings: Record<string, unknown>;
  ready: boolean;
  providerBuildFingerprint?: string | null;
}

export interface ProviderDetection {
  providerId: string;
  matched: boolean;
  buildFingerprint?: string | null;
  detail?: string;
}

export interface CancelResult {
  accepted: boolean;
  confirmedIdle: boolean;
  detail?: string;
}

export interface FinalReconciliation {
  generationId: GenerationId;
  messages: NormalizedMessage[];
  matchedStream: boolean;
  warnings: string[];
}

export interface TurnInput {
  input: Array<{ type: "input_text"; text: string } | Record<string, unknown>>;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  protocol?: string;
  /** Client tool definitions (OpenAI tools[]) preserved for emulated tool_calls. */
  tools?: CanonicalToolDefinition[];
}

export interface CreateAgentRequest {
  provider: string;
  account_id?: string;
  conversation?: {
    mode: "new" | "open";
    provider_conversation_id?: string;
  };
  settings?: Record<string, unknown>;
  metadata?: Record<string, string>;
}

export type { MessageId };
