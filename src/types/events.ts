import type { AgentId, EventId, GenerationId } from "./ids.js";
import type { AifrostError } from "./errors.js";
import type { NormalizedMessage } from "./messages.js";
import type { CanonicalToolIntent } from "./generation.js";

export interface AgentEventEnvelope<T = unknown> {
  id: EventId;
  seq: number;
  type: string;
  timestamp: string;
  agentId: AgentId;
  generationId?: GenerationId;
  providerId: string;
  payload: T;
}

/** Canonical generation events (provider → core → protocol adapters). */
export type CanonicalGenerationEvent =
  | { type: "generation.created"; generationId: GenerationId }
  | { type: "generation.started"; generationId: GenerationId }
  | { type: "reasoning.summary.delta"; generationId: GenerationId; delta: string }
  | { type: "output_text.delta"; generationId: GenerationId; delta: string }
  | {
      type: "output.snapshot";
      generationId: GenerationId;
      messages: NormalizedMessage[];
    }
  | { type: "citation.added"; generationId: GenerationId; citation: unknown }
  | { type: "tool_call.created"; generationId: GenerationId; call: unknown }
  | { type: "tool_call.delta"; generationId: GenerationId; delta: unknown }
  | { type: "tool_result.created"; generationId: GenerationId; result: unknown }
  | { type: "artifact.created"; generationId: GenerationId; artifact: unknown }
  | { type: "approval.required"; generationId: GenerationId; request: unknown }
  | {
      type: "generation.completed";
      generationId: GenerationId;
      messages: NormalizedMessage[];
      usage?: unknown;
      /** Optional OpenAI tool_calls façade (emulated / fixture). */
      toolIntents?: CanonicalToolIntent[];
    }
  | { type: "generation.cancelled"; generationId: GenerationId }
  | {
      type: "generation.failed";
      generationId: GenerationId;
      error: AifrostError;
    };

export type AgentLifecycleEventType =
  | "agent.lifecycle"
  | "agent.settings"
  | "agent.conversation"
  | "agent.auth"
  | "agent.recovery"
  | "agent.drift"
  | "agent.rate_limited"
  | "agent.error";
