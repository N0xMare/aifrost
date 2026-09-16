/**
 * End-to-end: Aifrost fixture agent + OpenAI Completions path that pifrost uses.
 * Does not load Pi; validates the wire contract pifrost depends on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { buildServer } from "../../src/api/server.js";
import type { FastifyInstance } from "fastify";
import { agentsToModels, buildProviderConfig } from "../../packages/pifrost/extensions/provider.js";
import { listAgents, healthCheck, createAgent } from "../../packages/pifrost/extensions/client.js";
import { normalizeBaseUrl, resolveConfig } from "../../packages/pifrost/extensions/config.js";

const token = "pifrost-test-token";

describe("pifrost bridge contract (fixture-web)", () => {
  let browser: MockBrowserBackend;
  let app: FastifyInstance;
  let agentId: string;
  const base = () => `http://127.0.0.1:${addressPort}`;
  let addressPort = 0;

  beforeAll(async () => {
    browser = new MockBrowserBackend();
    await browser.start({});
    const providers = createDefaultProviderRegistry();
    const agents = new AgentRegistry(browser, providers, null);
    app = await buildServer({ authToken: token, agents, providers });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    addressPort = addr.port;

    const create = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: "fixture-web", account_id: "acct_pi", metadata: { purpose: "pifrost" } },
    });
    expect(create.statusCode).toBe(201);
    agentId = create.json().id;
  });

  afterAll(async () => {
    await app.close();
    await browser.shutdown();
  });

  it("healthCheck succeeds", async () => {
    const h = await healthCheck(base(), token);
    expect(h.ok).toBe(true);
  });

  it("listAgents returns created agent", async () => {
    const agents = await listAgents(base(), token);
    expect(agents.some((a) => a.id === agentId)).toBe(true);
  });

  it("agentsToModels builds agent-scoped baseUrls", () => {
    const models = agentsToModels(
      [{ id: agentId, provider: "fixture-web", account_id: "acct_pi", lifecycle: "ready" }],
      normalizeBaseUrl(base()),
      "openai-completions",
    );
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe(agentId);
    expect(models[0]!.baseUrl).toBe(
      `${normalizeBaseUrl(base())}/compat/openai/agents/${agentId}/v1`,
    );
    expect(models[0]!.compat?.supportsDeveloperRole).toBe(false);
  });

  it("buildProviderConfig is valid for Pi registerProvider shape", () => {
    const cfg = buildProviderConfig(
      {
        ...resolveConfig({
          AIFROST_URL: normalizeBaseUrl(base()),
          AIFROST_AUTH_TOKEN: token,
          AIFROST_API: "openai-completions",
        }),
      },
      [{ id: agentId, provider: "fixture-web", account_id: "acct_pi", lifecycle: "ready" }],
    );
    expect(cfg.name).toBe("Aifrost");
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.authHeader).toBe(true);
    expect(cfg.models?.length).toBe(1);
    expect(cfg.apiKey).toBe("$AIFROST_AUTH_TOKEN");
  });

  it("chat completions via agent-scoped path (pifrost model baseUrl)", async () => {
    const url = `/compat/openai/agents/${agentId}/v1/chat/completions`;
    const res = await app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        model: "chatgpt-web",
        messages: [{ role: "user", content: "Say hi for pifrost" }],
        stream: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices?.[0]?.message?.content).toBeTruthy();
    expect(body.choices[0].message.content).toMatch(/Say hi for pifrost|Echo/i);
  });

  it("GET models on agent-scoped mount", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/compat/openai/agents/${agentId}/v1/models`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data?.length).toBeGreaterThan(0);
  });

  it("createAgent client creates fixture-web agent", async () => {
    const created = await createAgent(base(), token, {
      provider: "fixture-web",
      account_id: "acct_pi_create",
      metadata: { purpose: "pifrost-create" },
    });
    expect(created.id).toMatch(/^agt_/);
    expect(created.provider).toBe("fixture-web");
    expect(created.account_id).toBe("acct_pi_create");
  });

  it("listAgents rejects wrong token", async () => {
    await expect(listAgents(base(), "wrong-token")).rejects.toMatchObject({
      status: 401,
    });
  });
});
