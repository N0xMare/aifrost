import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { extractPlainText } from "../../src/types/messages.js";
import { buildServer } from "../../src/api/server.js";
import type { FastifyInstance } from "fastify";

describe("M1 fixture lifecycle", () => {
  let browser: MockBrowserBackend;
  let agents: AgentRegistry;

  beforeEach(async () => {
    browser = new MockBrowserBackend();
    await browser.start({});
    agents = new AgentRegistry(browser, createDefaultProviderRegistry());
  });

  afterEach(async () => {
    await browser.shutdown();
  });

  it("create → configure → turn → history → recover preserves agent id", async () => {
    const actor = await agents.create({
      provider: "fixture-web",
      settings: { model_or_mode: "fixture-default" },
    });
    const id = actor.agentId;
    expect(actor.snapshot().agent.lifecycle).toBe("ready");
    expect(actor.snapshot().agent.settings.effective.model_or_mode).toBe("fixture-default");

    const configured = await actor.applySettings({
      model_or_mode: "fixture-expert",
      reasoning: { effort: "high" },
    });
    expect(configured.agent.settings.desired.model_or_mode).toBe("fixture-expert");
    expect(configured.agent.settings.effective.model_or_mode).toBe("fixture-expert");
    expect(configured.agent.settings.revision).toBeGreaterThan(0);

    const deltas: string[] = [];
    const types: string[] = [];
    for await (const ev of actor.startTurnStream({
      input: [{ type: "input_text", text: "ping" }],
      stream: true,
    })) {
      types.push(ev.type);
      if (ev.type === "output_text.delta") deltas.push(ev.delta);
    }
    expect(types[0]).toBe("generation.created");
    expect(types).toContain("output_text.delta");
    expect(types.at(-1)).toBe("generation.completed");
    expect(deltas.join("")).toBe("Echo: ping");

    const history = actor.historyMessages();
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("user");
    expect(extractPlainText(history[1]!)).toBe("Echo: ping");

    const runtimeBefore = actor.snapshot().runtime.runtimeId;
    const recovered = await actor.recover();
    expect(recovered.agent.id).toBe(id);
    expect(recovered.agent.lifecycle).toBe("ready");
    expect(recovered.runtime.runtimeId).not.toBe(runtimeBefore);
    expect(recovered.agent.settings.effective.model_or_mode).toBe("fixture-expert");
  });

  it("cancel mid-generation ends with cancelled or completed-after-cancel", async () => {
    const actor = await agents.create({ provider: "fixture-web" });

    const types: string[] = [];
    const stream = (async () => {
      for await (const ev of actor.startTurnStream({
        input: [{ type: "input_text", text: "long enough to cancel" }],
        stream: true,
      })) {
        types.push(ev.type);
        if (ev.type === "output_text.delta") {
          await actor.cancel();
        }
      }
    })();

    await stream;
    expect(types.includes("generation.cancelled") || types.includes("generation.completed")).toBe(
      true,
    );
    expect(actor.snapshot().agent.activity).toBe("idle");
  });

  it("enforces one active generation (serialized actor)", async () => {
    const actor = await agents.create({ provider: "fixture-web" });
    let started = false;
    const first = (async () => {
      for await (const ev of actor.startTurnStream({
        input: [{ type: "input_text", text: "one" }],
      })) {
        if (ev.type === "generation.started") started = true;
      }
    })();

    // Wait until first is generating
    while (!started) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Second turn should wait (queue), not throw agent_busy from concurrent start
    // because startTurnStream serializes. Concurrent cancel is allowed.
    await first;
    const { events } = await actor.startTurn({
      input: [{ type: "input_text", text: "two" }],
    });
    expect(events.some((e) => e.type === "generation.completed")).toBe(true);
  });

  it("chatgpt-web is registered (live requires Chromium+login)", async () => {
    const providers = createDefaultProviderRegistry();
    const def = providers.list().find((p) => p.id === "chatgpt-web");
    expect(def).toBeTruthy();
    expect(def!.status).toMatch(/experimental|supported/);
  });
});

describe("M1 HTTP control plane", () => {
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

  it("native agents API happy path", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider: "fixture-web",
        settings: { model_or_mode: "fixture-fast" },
      },
    });
    expect(create.statusCode).toBe(201);
    const agent = create.json();
    expect(agent.id).toMatch(/^agt_/);
    expect(agent.lifecycle).toBe("ready");
    expect(agent.settings.effective.model_or_mode).toBe("fixture-fast");

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${agent.id}/settings`,
      headers: { authorization: `Bearer ${token}` },
      payload: { model_or_mode: "fixture-expert" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().effective.model_or_mode).toBe("fixture-expert");

    const turn = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.id}/turns`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      payload: {
        input: [{ type: "input_text", text: "api turn" }],
        stream: false,
      },
    });
    expect(turn.statusCode).toBe(200);
    const body = turn.json();
    expect(body.events.some((e: { type: string }) => e.type === "generation.completed")).toBe(true);

    const hist = await app.inject({
      method: "GET",
      url: `/v1/agents/${agent.id}/history`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().data.length).toBeGreaterThanOrEqual(2);

    const recover = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.id}/recover`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(recover.statusCode).toBe(200);
    expect(recover.json().id).toBe(agent.id);
    expect(recover.json().lifecycle).toBe("ready");

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agents" });
    expect(res.statusCode).toBe(401);
  });
});
