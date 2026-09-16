/**
 * ProviderWebUIAdapter — provider WebUI plugins only.
 * MUST emit canonical Aifrost events; MUST NOT build OpenAI/Anthropic responses.
 */

import type { ProviderCapabilities } from "../types/capabilities.js";
import type { CanonicalGenerationEvent } from "../types/events.js";
import type {
  CancelResult,
  CanonicalGenerationRequest,
  FinalReconciliation,
  ObservedAgentState,
  ProviderConversationRef,
  ProviderDetection,
} from "../types/generation.js";
import type { NormalizedMessage } from "../types/messages.js";
import type { SettingsApplyResult } from "../types/settings.js";
import type { BrowserSession } from "../browser/backend.js";
import type { AgentId } from "../types/ids.js";

export interface ProviderPageContext {
  agentId: AgentId;
  providerId: string;
  session: BrowserSession;
  accountId: string;
  /** Host-side helper to evaluate bridge commands */
  bridge: PageBridgeHost;
}

export interface PageBridgeHost {
  invoke(command: Record<string, unknown>): Promise<unknown>;
  drain(afterSeq: number, maxEvents?: number): Promise<BridgeDrainResult>;
  acknowledge(seq: number): Promise<void>;
}

export interface BridgeDrainResult {
  events: Array<{ seq: number; type: string; payload: unknown; timestamp?: string }>;
  latestSeq: number;
  overflow: boolean;
}

export interface ProviderWebUIAdapter {
  readonly id: string;
  readonly version: string;
  readonly hosts: string[];

  detect(ctx: ProviderPageContext): Promise<ProviderDetection>;
  awaitReady(ctx: ProviderPageContext): Promise<void>;
  inspectCapabilities(ctx: ProviderPageContext): Promise<ProviderCapabilities>;
  readState(ctx: ProviderPageContext): Promise<ObservedAgentState>;

  createConversation(ctx: ProviderPageContext): Promise<ProviderConversationRef>;
  openConversation(ctx: ProviderPageContext, ref: ProviderConversationRef): Promise<void>;

  applySettings(
    ctx: ProviderPageContext,
    desired: Record<string, unknown>,
  ): Promise<SettingsApplyResult>;

  generate(
    ctx: ProviderPageContext,
    request: CanonicalGenerationRequest,
  ): AsyncIterable<CanonicalGenerationEvent>;

  cancel(ctx: ProviderPageContext, generationId: string): Promise<CancelResult>;
  readHistory(ctx: ProviderPageContext): Promise<NormalizedMessage[]>;
  reconcileFinal(ctx: ProviderPageContext, generationId: string): Promise<FinalReconciliation>;
}
