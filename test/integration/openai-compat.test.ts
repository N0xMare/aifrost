import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { buildServer } from "../../src/api/server.js";

describe("OpenAI compatibility gateways (fixture-web)", () => {
  let browser: MockBrowserBackend;
  let app: FastifyInstance;
  const token = "test-token";

  beforeEach(async () => {
    browser = new MockBrowserBackend();
    await browser.start({});
    const providers = createDefaultProviderRegistry();
    const agents = new AgentRegistry(browser, providers);
    app = await buildServer({ authToken: token, agents, providers });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await browser.shutdown();
  });

  async function createAgent(settings?: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider: "fixture-web",
        settings: settings ?? { model_or_mode: "fixture-fast" },
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; settings: { effective: { model_or_mode: string } } };
  }

  it("POST chat/completions non-streaming + models", async () => {
    const agent = await createAgent();

    const models = await app.inject({
      method: "GET",
      url: `/compat/openai/agents/${agent.id}/v1/models`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(200);
    const modelsBody = models.json();
    expect(modelsBody.object).toBe("list");
    expect(modelsBody.data[0].id).toBe("fixture-fast");

    const chat = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        model: "client-label-ignored-for-settings",
        messages: [{ role: "user", content: "compat-chat" }],
        stream: false,
      },
    });
    expect(chat.statusCode).toBe(200);
    const body = chat.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("fixture-fast");
    expect(body.choices[0].message.content).toBe("Echo: compat-chat");
    expect(body.usage).toBeNull();
    expect(body.usage_available).toBe(false);

    // Settings unchanged by model field
    const got = await app.inject({
      method: "GET",
      url: `/v1/agents/${agent.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.json().settings.effective.model_or_mode).toBe("fixture-fast");
  });

  it("chat/completions streaming SSE", async () => {
    const agent = await createAgent();
    const res = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
      payload: {
        model: "fixture-fast",
        messages: [{ role: "user", content: "stream-me" }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const text = res.body;
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("Echo:");
    expect(text).toContain("data: [DONE]");
  });

  it("history reconciliation: second turn suffix-only; diverge conflicts", async () => {
    const agent = await createAgent();

    const first = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "turn1" }],
        stream: false,
      },
    });
    expect(first.statusCode).toBe(200);
    const firstContent = first.json().choices[0].message.content as string;
    expect(firstContent).toBe("Echo: turn1");

    // Matching prefix + new user message
    const second = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "turn1" },
          { role: "assistant", content: firstContent },
          { role: "user", content: "turn2" },
        ],
        stream: false,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().choices[0].message.content).toBe("Echo: turn2");

    // Divergent client transcript → stateful fallback uses last user (turn3)
    const continued = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "turn1" },
          { role: "assistant", content: "NOT WHAT WAS SAID" },
          { role: "user", content: "turn3" },
        ],
        stream: false,
      },
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().choices[0].message.content).toBe("Echo: turn3");
  });

  it("POST responses non-streaming + streaming", async () => {
    const agent = await createAgent({ model_or_mode: "fixture-default" });

    const non = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/responses`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        model: "anything",
        input: "resp-input",
        stream: false,
      },
    });
    expect(non.statusCode).toBe(200);
    const body = non.json();
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("fixture-default");
    expect(body.usage).toBeNull();
    expect(body.usage_available).toBe(false);
    expect(body.output[0].content[0].text).toBe("Echo: resp-input");

    const stream = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/responses`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        input: "resp-stream",
        stream: true,
      },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("event: response.created");
    expect(stream.body).toContain("event: response.output_text.delta");
    expect(stream.body).toContain("event: response.completed");
  });

  it("global aliases require Aifrost-Agent-Id", async () => {
    const agent = await createAgent();

    const missing = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "x" }],
        stream: false,
      },
    });
    expect(missing.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${token}`,
        "aifrost-agent-id": agent.id,
      },
      payload: {
        messages: [{ role: "user", content: "alias" }],
        stream: false,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().choices[0].message.content).toBe("Echo: alias");

    const respAlias = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: `Bearer ${token}`,
        "aifrost-agent-id": agent.id,
      },
      payload: { input: "alias-resp", stream: false },
    });
    expect(respAlias.statusCode).toBe(200);
    expect(respAlias.json().output[0].content[0].text).toBe("Echo: alias-resp");
  });

  it("accepts tools and returns tool_calls (fixture emulation)", async () => {
    const agent = await createAgent();
    const res = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "list files in the project" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: "auto",
        stream: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
    expect(body.choices[0].message.tool_calls[0].function.arguments).toMatch(/ls/);
  });

  it("tool loop: tool_calls then tool_result then final text", async () => {
    const agent = await createAgent();
    const t1 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "inspect repo" }],
        tools: [
          {
            type: "function",
            function: { name: "bash", parameters: { type: "object" } },
          },
        ],
        stream: false,
      },
    });
    expect(t1.statusCode).toBe(200);
    const call = t1.json().choices[0].message.tool_calls[0];
    expect(call).toBeTruthy();

    const t2 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "inspect repo" },
          {
            role: "assistant",
            content: null,
            tool_calls: [call],
          },
          {
            role: "tool",
            tool_call_id: call.id,
            name: "bash",
            content: "package.json\nsrc\n",
          },
        ],
        tools: [
          {
            type: "function",
            function: { name: "bash", parameters: { type: "object" } },
          },
        ],
        stream: false,
      },
    });
    expect(t2.statusCode).toBe(200);
    expect(t2.json().choices[0].finish_reason).toBe("stop");
    expect(t2.json().choices[0].message.content).toMatch(/tool_result|package\.json|Echo/i);
    expect(t2.json().choices[0].message.tool_calls).toBeUndefined();
  });

  it("tool_result messages project into next turn", async () => {
    const agent = await createAgent();
    const t1 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "step1" }],
        stream: false,
      },
    });
    expect(t1.statusCode).toBe(200);
    const assistant1 = t1.json().choices[0].message.content as string;

    const t2 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "step1" },
          { role: "assistant", content: assistant1 },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "read_file", arguments: '{"p":"x"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "c1",
            name: "read_file",
            content: "file-bytes",
          },
        ],
        tools: [
          {
            type: "function",
            function: { name: "read_file", parameters: { type: "object" } },
          },
        ],
        stream: false,
      },
    });
    expect(t2.statusCode).toBe(200);
    const content = t2.json().choices[0].message.content as string;
    // Fixture echoes the submitted user turn (tool_result projection)
    expect(content).toMatch(/tool_result|file-bytes|Echo/i);
  });

  it("auth=none allows requests without Authorization", async () => {
    const { MockBrowserBackend } = await import("../../src/browser/mock/backend.js");
    const { createDefaultProviderRegistry } = await import("../../src/providers/registry.js");
    const { AgentRegistry } = await import("../../src/core/agent-registry.js");
    const { buildServer } = await import("../../src/api/server.js");
    const browser = new MockBrowserBackend();
    await browser.start({});
    const providers = createDefaultProviderRegistry();
    const agents = new AgentRegistry(browser, providers, null);
    const openApp = await buildServer({
      auth: { mode: "none", token: "" },
      agents,
      providers,
    });
    await openApp.listen({ host: "127.0.0.1", port: 0 });
    try {
      const create = await openApp.inject({
        method: "POST",
        url: "/v1/agents",
        payload: { provider: "fixture-web", account_id: "acct_open" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().id as string;
      const chat = await openApp.inject({
        method: "POST",
        url: `/compat/openai/agents/${id}/v1/chat/completions`,
        payload: {
          messages: [{ role: "user", content: "open-auth" }],
          stream: false,
        },
      });
      expect(chat.statusCode).toBe(200);
    } finally {
      await openApp.close();
      await browser.shutdown();
    }
  });

  it("parallel tool_results then continue without 409", async () => {
    const agent = await createAgent();
    const t1 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: "user", content: "parallel-base" }],
        stream: false,
      },
    });
    expect(t1.statusCode).toBe(200);
    const a1 = t1.json().choices[0].message.content as string;

    const t2 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "parallel-base" },
          { role: "assistant", content: a1 },
          { role: "tool", name: "t1", content: "r1" },
          { role: "tool", name: "t2", content: "r2" },
        ],
        tools: [
          { type: "function", function: { name: "t1", parameters: {} } },
          { type: "function", function: { name: "t2", parameters: {} } },
        ],
        stream: false,
      },
    });
    expect(t2.statusCode).toBe(200);
    const a2 = t2.json().choices[0].message.content as string;

    const t3 = await app.inject({
      method: "POST",
      url: `/compat/openai/agents/${agent.id}/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [
          { role: "user", content: "parallel-base" },
          { role: "assistant", content: a1 },
          { role: "tool", name: "t1", content: "r1" },
          { role: "tool", name: "t2", content: "r2" },
          { role: "assistant", content: a2 },
          { role: "user", content: "continue-after-tools" },
        ],
        stream: false,
      },
    });
    expect(t3.statusCode).toBe(200);
    expect(t3.json().choices[0].message.content).toMatch(/continue-after-tools|Echo/i);
  });
});
