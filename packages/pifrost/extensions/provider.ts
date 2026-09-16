/**
 * Map Aifrost agents → Pi provider model configs.
 * Pure helpers — no Pi imports.
 */

import type { AifrostApi, AifrostConfig } from "./config.js";
import { normalizeBaseUrl } from "./config.js";
import type { AifrostAgent } from "./client.js";

/** Subset of Pi ProviderModelConfig used by registerProvider. */
export interface PiModelConfig {
  id: string;
  name: string;
  baseUrl?: string;
  api?: AifrostApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsUsageInStreaming: boolean;
  };
}

/** Subset of Pi ProviderConfig used by registerProvider. */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  api: AifrostApi;
  models: PiModelConfig[];
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
} as const;

/** Lifecycle preference: lower rank = preferred. Deleted is filtered separately. */
const LIFECYCLE_RANK: Record<string, number> = {
  ready: 0,
  degraded: 1,
  recovering: 2,
  creating: 3,
  failed: 4,
  deleting: 5,
};

export function isDeletedAgent(agent: AifrostAgent): boolean {
  return agent.lifecycle === "deleted";
}

/** Short id fragment for display (suffix after agt_, up to 8 chars). */
export function shortAgentId(id: string): string {
  const bare = id.startsWith("agt_") ? id.slice(4) : id;
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

/** Human label: clear provider kind + account + lifecycle + short id. */
export function modelNameForAgent(agent: AifrostAgent): string {
  const provider = agent.provider || "unknown";
  const account = agent.account_id || "unknown";
  const life = agent.lifecycle && agent.lifecycle !== "ready" ? agent.lifecycle : "";
  // Make live ChatGPT obvious vs fixture (Echo) in /model pickers
  const kind =
    provider === "chatgpt-web"
      ? "ChatGPT"
      : provider === "fixture-web"
        ? "Fixture(Echo)"
        : provider;
  const tail = [life, shortAgentId(agent.id)].filter(Boolean).join(" · ");
  return `${kind} · ${account} · ${tail}`;
}

/** Per-agent OpenAI-compat base URL for Pi. */
export function agentCompatBaseUrl(baseUrl: string, agentId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/compat/openai/agents/${agentId}/v1`;
}

/**
 * Sort agents: preferred default first, then ready/degraded over failed, then id.
 * Deleted agents must already be filtered out.
 */
/** Prefer live ChatGPT over fixture when picking models. */
const PROVIDER_RANK: Record<string, number> = {
  "chatgpt-web": 0,
  "fixture-web": 10,
};

export function sortAgents(agents: AifrostAgent[], defaultAgent?: string): AifrostAgent[] {
  return [...agents].sort((a, b) => {
    if (defaultAgent) {
      if (a.id === defaultAgent && b.id !== defaultAgent) return -1;
      if (b.id === defaultAgent && a.id !== defaultAgent) return 1;
    }
    // Ready/degraded before failed, then prefer ChatGPT over Fixture
    const ra = LIFECYCLE_RANK[a.lifecycle] ?? 50;
    const rb = LIFECYCLE_RANK[b.lifecycle] ?? 50;
    if (ra !== rb) return ra - rb;
    const pa = PROVIDER_RANK[a.provider] ?? 5;
    const pb = PROVIDER_RANK[b.provider] ?? 5;
    if (pa !== pb) return pa - pb;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Convert Aifrost agents to Pi model configs.
 * Filters deleted agents; prefers ready/degraded; optional default agent first.
 */
export function filterAgentsForModels(
  agents: AifrostAgent[],
  filter: AifrostConfig["modelFilter"] = "chatgpt",
): AifrostAgent[] {
  const active = agents.filter((a) => !isDeletedAgent(a));
  if (filter === "all") return active;
  if (filter === "fixture") {
    return active.filter((a) => a.provider === "fixture-web");
  }
  // chatgpt (default): live ChatGPT only — if none, fall back to all so /model is not empty
  const chatgpt = active.filter((a) => a.provider === "chatgpt-web");
  return chatgpt.length > 0 ? chatgpt : active;
}

export function agentsToModels(
  agents: AifrostAgent[],
  baseUrl: string,
  api: AifrostApi,
  defaultAgent?: string,
  modelFilter: AifrostConfig["modelFilter"] = "chatgpt",
): PiModelConfig[] {
  const root = normalizeBaseUrl(baseUrl);
  const active = filterAgentsForModels(agents, modelFilter);
  const ordered = sortAgents(active, defaultAgent);

  return ordered.map((agent) => ({
    id: agent.id,
    name: modelNameForAgent(agent),
    baseUrl: agentCompatBaseUrl(root, agent.id),
    api,
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 128_000,
    maxTokens: 8192,
    compat: { ...COMPAT },
  }));
}

/**
 * Build the full Pi `registerProvider` config for Aifrost.
 * Uses `$AIFROST_AUTH_TOKEN` so Pi resolves the env var per request (no secrets in logs).
 */
export function buildProviderConfig(
  config: AifrostConfig,
  agents: AifrostAgent[],
): PiProviderConfig {
  const models = agentsToModels(
    agents,
    config.baseUrl,
    config.api,
    config.defaultAgent,
    config.modelFilter,
  );
  // When no agents are registered, use the control-plane origin (not a fake
  // /compat/openai mount — that path does not exist on the server).
  const baseUrl = models[0]?.baseUrl ?? normalizeBaseUrl(config.baseUrl);

  return {
    name: "Aifrost",
    baseUrl,
    // Pi expands $ENV; when authHeader is false, key is unused for Authorization.
    apiKey: config.authHeader ? "$AIFROST_AUTH_TOKEN" : "local-no-auth",
    authHeader: config.authHeader,
    api: config.api,
    models,
  };
}

/** Stable provider id used with registerProvider / unregisterProvider. */
export const AIFROST_PROVIDER_ID = "aifrost";
