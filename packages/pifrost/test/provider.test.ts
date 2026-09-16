import { describe, expect, it } from "vitest";
import type { AifrostAgent } from "../extensions/client.js";
import {
  AIFROST_PROVIDER_ID,
  agentCompatBaseUrl,
  agentsToModels,
  buildProviderConfig,
  isDeletedAgent,
  modelNameForAgent,
  shortAgentId,
  sortAgents,
} from "../extensions/provider.js";
import { resolveConfig } from "../extensions/config.js";

function agent(
  partial: Partial<AifrostAgent> & Pick<AifrostAgent, "id" | "lifecycle">,
): AifrostAgent {
  return {
    provider: "chatgpt-web",
    account_id: "acct_default",
    ...partial,
  };
}

describe("shortAgentId / modelNameForAgent", () => {
  it("shortens agt_ prefix suffix", () => {
    expect(shortAgentId("agt_abcdefghij")).toBe("abcdefgh");
    expect(shortAgentId("agt_ab")).toBe("ab");
  });

  it("builds human label", () => {
    expect(
      modelNameForAgent(
        agent({
          id: "agt_abcdefghij",
          lifecycle: "ready",
          provider: "chatgpt-web",
          account_id: "acct_main",
        }),
      ),
    ).toBe("ChatGPT · acct_main · abcdefgh");
    expect(
      modelNameForAgent(
        agent({
          id: "agt_fixture01",
          lifecycle: "ready",
          provider: "fixture-web",
          account_id: "acct_pi",
        }),
      ),
    ).toMatch(/^Fixture\(Echo\)/);
  });
});

describe("isDeletedAgent / sortAgents", () => {
  it("detects deleted", () => {
    expect(isDeletedAgent(agent({ id: "agt_1", lifecycle: "deleted" }))).toBe(true);
    expect(isDeletedAgent(agent({ id: "agt_1", lifecycle: "ready" }))).toBe(false);
  });

  it("prefers ready/degraded over failed", () => {
    const sorted = sortAgents([
      agent({ id: "agt_f", lifecycle: "failed" }),
      agent({ id: "agt_d", lifecycle: "degraded" }),
      agent({ id: "agt_r", lifecycle: "ready" }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["agt_r", "agt_d", "agt_f"]);
  });

  it("puts default agent first", () => {
    const sorted = sortAgents(
      [agent({ id: "agt_a", lifecycle: "ready" }), agent({ id: "agt_b", lifecycle: "ready" })],
      "agt_b",
    );
    expect(sorted[0]?.id).toBe("agt_b");
  });
});

describe("agentsToModels", () => {
  it("filters deleted and maps fields", () => {
    const models = agentsToModels(
      [
        agent({
          id: "agt_ready0001",
          lifecycle: "ready",
          provider: "fixture-web",
          account_id: "acct_default",
        }),
        agent({ id: "agt_gone", lifecycle: "deleted" }),
        agent({
          id: "agt_fail0001",
          lifecycle: "failed",
          provider: "chatgpt-web",
          account_id: "acct_x",
        }),
      ],
      "http://127.0.0.1:8787/",
      "openai-completions",
      undefined,
      "all",
    );

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("agt_ready0001");
    expect(models[0]?.baseUrl).toBe("http://127.0.0.1:8787/compat/openai/agents/agt_ready0001/v1");
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.input).toEqual(["text"]);
    expect(models[0]?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(models[0]?.contextWindow).toBe(128_000);
    expect(models[0]?.maxTokens).toBe(8192);
    expect(models[0]?.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    });
    expect(models[1]?.id).toBe("agt_fail0001");
  });

  it("honors default agent and responses api", () => {
    const models = agentsToModels(
      [
        agent({ id: "agt_a", lifecycle: "ready", provider: "chatgpt-web" }),
        agent({ id: "agt_b", lifecycle: "ready", provider: "chatgpt-web" }),
      ],
      "http://x",
      "openai-responses",
      "agt_b",
      "chatgpt",
    );
    expect(models[0]?.id).toBe("agt_b");
    expect(models[0]?.api).toBe("openai-responses");
  });

  it("chatgpt filter hides fixture when ChatGPT exists", () => {
    const models = agentsToModels(
      [
        agent({
          id: "agt_fix1",
          lifecycle: "ready",
          provider: "fixture-web",
        }),
        agent({
          id: "agt_gpt1",
          lifecycle: "ready",
          provider: "chatgpt-web",
          account_id: "acct_main",
        }),
      ],
      "http://x",
      "openai-completions",
      undefined,
      "chatgpt",
    );
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("agt_gpt1");
  });
});

describe("agentCompatBaseUrl", () => {
  it("normalizes base and builds path", () => {
    expect(agentCompatBaseUrl("http://h:1/", "agt_1")).toBe(
      "http://h:1/compat/openai/agents/agt_1/v1",
    );
  });
});

describe("buildProviderConfig", () => {
  it("sets provider metadata and env apiKey ref", () => {
    const config = resolveConfig({
      AIFROST_URL: "http://127.0.0.1:8787",
      AIFROST_AUTH_TOKEN: "tok",
      AIFROST_API: "openai-completions",
    });
    const provider = buildProviderConfig(config, [agent({ id: "agt_x", lifecycle: "ready" })]);

    expect(AIFROST_PROVIDER_ID).toBe("aifrost");
    expect(provider.name).toBe("Aifrost");
    expect(provider.apiKey).toBe("$AIFROST_AUTH_TOKEN");
    expect(provider.authHeader).toBe(true);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toHaveLength(1);
    expect(provider.baseUrl).toBe(provider.models[0]?.baseUrl);
  });

  it("disables authHeader when no token", () => {
    const config = resolveConfig({ AIFROST_URL: "http://127.0.0.1:8787" });
    const provider = buildProviderConfig(config, [agent({ id: "agt_x", lifecycle: "ready" })]);
    expect(provider.authHeader).toBe(false);
    expect(provider.apiKey).toBe("local-no-auth");
  });

  it("uses control-plane origin when no models", () => {
    const config = resolveConfig({ AIFROST_URL: "http://127.0.0.1:8787/" });
    const provider = buildProviderConfig(config, []);
    expect(provider.models).toEqual([]);
    expect(provider.baseUrl).toBe("http://127.0.0.1:8787");
  });
});
