import type { AgentId, AccountId, GenerationId } from "./ids.js";
import type { SettingsSnapshot } from "./settings.js";

export type AgentLifecycle =
  "creating" | "ready" | "degraded" | "recovering" | "failed" | "deleting" | "deleted";

export type AgentActivity = "idle" | "queued" | "generating" | "awaiting_approval" | "cancelling";

export type AgentAuthState = "unknown" | "authenticated" | "expired" | "login_required";

export type GenerationState =
  | "queued"
  | "starting"
  | "streaming"
  | "awaiting_approval"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface ConversationState {
  providerConversationId: string | null;
  providerUrl: string | null;
  title: string | null;
  turnCount: number;
  historyRevision: number;
  fingerprint: string | null;
}

export interface Generation {
  id: GenerationId;
  agentId: AgentId;
  protocol: string;
  state: GenerationState;
  inputMessageIds: string[];
  outputMessageIds: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface Agent {
  id: AgentId;
  providerId: string;
  accountId: AccountId;
  lifecycle: AgentLifecycle;
  activity: AgentActivity;
  auth: AgentAuthState;
  settings: SettingsSnapshot;
  conversation: ConversationState;
  currentGenerationId: GenerationId | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** Opaque revision for optimistic concurrency on agent state. */
  revision: number;
}

export interface AgentPublicView {
  id: AgentId;
  object: "agent";
  provider: string;
  account_id: AccountId;
  lifecycle: AgentLifecycle;
  activity: AgentActivity;
  auth: AgentAuthState;
  revision: number;
  settings: {
    desired: Record<string, unknown>;
    effective: Record<string, unknown>;
    revision: number;
    capabilities_revision: string | null;
    observed_at: string | null;
  };
  conversation: {
    provider_conversation_id: string | null;
    provider_url: string | null;
    title: string | null;
    turn_count: number;
    history_revision: number;
    fingerprint: string | null;
  };
  current_generation: {
    id: GenerationId;
    state: GenerationState;
    started_at: string | null;
  } | null;
  runtime: {
    healthy: boolean;
    page_ready: boolean;
    bridge_version: string | null;
    provider_build_fingerprint: string | null;
  };
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export function toPublicAgent(
  agent: Agent,
  runtime?: {
    healthy: boolean;
    pageReady: boolean;
    bridgeVersion: string | null;
    providerBuildFingerprint: string | null;
  },
  generation?: Generation | null,
): AgentPublicView {
  return {
    id: agent.id,
    object: "agent",
    provider: agent.providerId,
    account_id: agent.accountId,
    lifecycle: agent.lifecycle,
    activity: agent.activity,
    auth: agent.auth,
    revision: agent.revision,
    settings: {
      desired: agent.settings.desired,
      effective: agent.settings.effective,
      revision: agent.settings.revision,
      capabilities_revision: agent.settings.capabilitiesRevision,
      observed_at: agent.settings.observedAt,
    },
    conversation: {
      provider_conversation_id: agent.conversation.providerConversationId,
      provider_url: agent.conversation.providerUrl,
      title: agent.conversation.title,
      turn_count: agent.conversation.turnCount,
      history_revision: agent.conversation.historyRevision,
      fingerprint: agent.conversation.fingerprint,
    },
    current_generation: generation
      ? {
          id: generation.id,
          state: generation.state,
          started_at: generation.startedAt,
        }
      : null,
    runtime: {
      healthy: runtime?.healthy ?? false,
      page_ready: runtime?.pageReady ?? false,
      bridge_version: runtime?.bridgeVersion ?? null,
      provider_build_fingerprint: runtime?.providerBuildFingerprint ?? null,
    },
    metadata: agent.metadata,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}
