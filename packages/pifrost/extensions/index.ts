/**
 * Pi extension entry: register Aifrost as an OpenAI-compatible inference provider.
 *
 * Types only from @earendil-works/pi-coding-agent so pure unit tests do not need
 * the peer package installed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfig, hasAuthToken, type AifrostConfig } from "./config.js";
import { healthCheck, listAgents, type AifrostAgent, AifrostClientError } from "./client.js";
import { AIFROST_PROVIDER_ID, buildProviderConfig, type PiProviderConfig } from "./provider.js";
import { handleAifrostCommand } from "./commands.js";

interface ExtensionState {
  config: AifrostConfig;
  lastHealthOk: boolean | null;
  lastError: string | null;
  agents: AifrostAgent[];
}

function registerAifrostProvider(pi: ExtensionAPI, providerConfig: PiProviderConfig): void {
  // unregister first so refresh replaces models cleanly
  try {
    pi.unregisterProvider(AIFROST_PROVIDER_ID);
  } catch {
    // not registered yet
  }
  pi.registerProvider(AIFROST_PROVIDER_ID, providerConfig);
}

async function fetchAgents(config: AifrostConfig): Promise<{
  agents: AifrostAgent[];
  healthOk: boolean;
  error: string | null;
}> {
  // Keep health distinct from list/auth failures so UX messages stay accurate.
  let healthOk = false;
  try {
    const health = await healthCheck(config.baseUrl, config.authToken);
    healthOk = health.ok;
  } catch (err) {
    const message =
      err instanceof AifrostClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { agents: [], healthOk: false, error: message };
  }

  try {
    const agents = await listAgents(config.baseUrl, config.authToken);
    return { agents, healthOk, error: null };
  } catch (err) {
    const message =
      err instanceof AifrostClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    // Health succeeded; do not mislabel as "Aifrost down".
    return { agents: [], healthOk, error: message };
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = resolveConfig();
  const state: ExtensionState = {
    config,
    lastHealthOk: null,
    lastError: null,
    agents: [],
  };

  const applyRegistration = (agents: AifrostAgent[]): void => {
    state.agents = agents;
    const providerConfig = buildProviderConfig(state.config, agents);
    registerAifrostProvider(pi, providerConfig);
  };

  const refresh = async (): Promise<{
    agents: AifrostAgent[];
    error: string | null;
  }> => {
    // Re-read env so token/url changes can take effect without restart when possible
    state.config = resolveConfig();
    const result = await fetchAgents(state.config);
    state.lastHealthOk = result.healthOk;
    state.lastError = result.error;
    applyRegistration(result.agents);
    return { agents: result.agents, error: result.error };
  };

  // Startup: health + list; on failure register empty models
  const initial = await fetchAgents(state.config);
  state.lastHealthOk = initial.healthOk;
  state.lastError = initial.error;
  applyRegistration(initial.agents);

  pi.on("session_start", async (_event, ctx) => {
    if (state.lastHealthOk === false) {
      const detail = state.lastError ? ` (${state.lastError})` : "";
      ctx.ui.notify(
        `Aifrost appears down or unreachable at ${state.config.baseUrl}${detail}. Models may be empty until /aifrost refresh.`,
        "warning",
      );
    } else if (state.lastError) {
      // 401 usually means server wants bearer and client has no/wrong token
      const hint =
        /401|unauthorized/i.test(state.lastError) && !hasAuthToken(state.config)
          ? " Set AIFROST_AUTH_TOKEN (or AIFROST_AUTH=none on both sides for local no-auth)."
          : "";
      ctx.ui.notify(
        `Aifrost connected but agent list failed: ${state.lastError}.${hint}`,
        "warning",
      );
    } else if (!state.config.authHeader) {
      ctx.ui.notify("Aifrost auth disabled (no bearer). Fine for local AIFROST_AUTH=none.", "info");
    }
  });

  pi.registerCommand("aifrost", {
    description: "Aifrost control: status | agents | refresh | create | ratelimit | help",
    handler: async (args, ctx) => {
      // Re-read env on every command (token/url may change outside Pi).
      state.config = resolveConfig();
      await handleAifrostCommand(args ?? "", ctx.ui, {
        config: state.config,
        refresh,
      });
    },
  });
}
