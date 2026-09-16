/**
 * API surface coverage: providers listing/detail/capabilities, /events SSE
 * backlog, /cancel on idle, request-body validation, and Idempotency-Key
 * wiring on POST /v1/agents + non-stream turns.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { openMemoryDb } from "../../src/persistence/db.js";
import { AgentStore } from "../../src/persistence/repositories.js";

const token = "test-token";
const authH = { authorization: `Bearer ${token}` };

describe("API surface", () => {
  let browser: MockBrowserBackend;
  let app: FastifyInstance;

  beforeEach(async () => {
    browser = new MockBrowserBackend();
    await browser.start({});
    const providers = createDefaultProviderRegistry();
    const agents = new AgentRegistry(browser, providers);
    app = await buildServer({
      authToken: token,
      agents,
      providers,
      store: new AgentStore(openMemoryDb()),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await browser.shutdown();
  });

  async function createAgent(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: authH,
      payload: { provider: "fixture-web" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("lists providers and serves detail + capabilities", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: authH,
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().data.map((p: { id: string }) => p.id);
    expect(ids).toContain("fixture-web");
    expect(ids).toContain("chatgpt-web");

    const detail = await app.inject({
      method: "GET",
      url: "/v1/providers/fixture-web",
      headers: authH,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe("fixture-web");

    const caps = await app.inject({
      method: "GET",
      url: "/v1/providers/fixture-web/capabilities",
      headers: authH,
    });
    expect(caps.statusCode).toBe(200);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/providers/nope",
      headers: authH,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("provider_not_found");
  });

  it("streams /events backlog once, then stays live", async () => {
    const agentId = await createAgent();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/agents/${agentId}/events`, {
        headers: authH,
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      ac.abort();
      await reader.cancel().catch(() => undefined);
      // Agent creation emits backlog events; each event must appear once.
      const seqs = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(seqs.length).toBeGreaterThan(0);
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      // real listener must be torn down so afterEach app.close() is clean
      await app.close();
      app = await buildServer({
        authToken: token,
        agents: new AgentRegistry(browser, createDefaultProviderRegistry()),
        providers: createDefaultProviderRegistry(),
        store: new AgentStore(openMemoryDb()),
      });
      await app.ready();
    }
  });

  it("cancel on an idle agent is a safe no-op", async () => {
    const agentId = await createAgent();
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/cancel`,
      headers: authH,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent_id).toBe(agentId);
  });

  it("rejects malformed bodies with 4xx, not 500", async () => {
    const agentId = await createAgent();
    const badInput = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/turns`,
      headers: authH,
      payload: { input: "not-an-array" },
    });
    expect(badInput.statusCode).toBe(400);

    const badItem = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/turns`,
      headers: authH,
      payload: { input: [42] },
    });
    expect(badItem.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...authH, "content-type": "application/json" },
      payload: "{oops",
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("replays POST /v1/agents under the same Idempotency-Key", async () => {
    const headers = { ...authH, "idempotency-key": "key-1" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers,
      payload: { provider: "fixture-web" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBe("false");

    const second = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers,
      payload: { provider: "fixture-web" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);

    const list = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: authH,
    });
    expect(list.json().data).toHaveLength(1);
  });

  it("rejects Idempotency-Key on streaming turns", async () => {
    const agentId = await createAgent();
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/turns`,
      headers: { ...authH, "idempotency-key": "k", accept: "text/event-stream" },
      payload: {
        input: [{ type: "input_text", text: "hi" }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("replays non-stream turns under the same Idempotency-Key", async () => {
    const agentId = await createAgent();
    const payload = {
      input: [{ type: "input_text", text: "idem turn" }],
      stream: false,
    };
    const headers = { ...authH, "idempotency-key": "turn-1" };
    const first = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/turns`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/turns`,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().generation.id).toBe(first.json().generation.id);
    // history must not double-append the replayed turn
    const hist = await app.inject({
      method: "GET",
      url: `/v1/agents/${agentId}/history`,
      headers: authH,
    });
    const userTurns = hist.json().data.filter((m: { role: string }) => m.role === "user");
    expect(userTurns).toHaveLength(1);
  });
});
