/**
 * InferenceProtocolAdapter — OpenAI/Anthropic/etc. translators only.
 * MUST consume canonical events; MUST NOT contain provider DOM/network logic.
 */

import type { Agent } from "../types/agent.js";
import type { ProviderCapabilities } from "../types/capabilities.js";
import type { AifrostError } from "../types/errors.js";
import type { CanonicalGenerationEvent } from "../types/events.js";
import type { CanonicalGenerationRequest, CanonicalGenerationResult } from "../types/generation.js";

export interface ProtocolHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  agentIdHeader?: string;
}

export interface ProtocolHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface InferenceProtocolAdapter {
  readonly id: string;

  parseRequest(http: ProtocolHttpRequest, agent: Agent): Promise<CanonicalGenerationRequest>;

  validate(request: CanonicalGenerationRequest, capabilities: ProviderCapabilities): void;

  encodeNonStreaming(result: CanonicalGenerationResult): ProtocolHttpResponse;

  encodeStreaming(events: AsyncIterable<CanonicalGenerationEvent>): AsyncIterable<Uint8Array>;

  encodeError(error: AifrostError): ProtocolHttpResponse;
}
