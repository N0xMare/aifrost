import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestInfo } from "undici-types";
import { AifrostClientError, createAgent, healthCheck, listAgents } from "../extensions/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("healthCheck", () => {
  it("returns ok from /healthz", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:8787/healthz");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(healthCheck("http://127.0.0.1:8787/", "tok")).resolves.toEqual({ ok: true });
  });

  it("throws on non-OK HTTP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(healthCheck("http://x", "")).rejects.toBeInstanceOf(AifrostClientError);
  });

  it("throws on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(healthCheck("http://x", "")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("listAgents", () => {
  it("allows empty token (no-auth server)", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      return jsonResponse({ object: "list", data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listAgents("http://host", "")).resolves.toEqual([]);
  });

  it("returns data array and sends bearer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://host/v1/agents");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer tok");
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "agt_1",
            provider: "chatgpt-web",
            account_id: "acct_default",
            lifecycle: "ready",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const agents = await listAgents("http://host/", "tok");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe("agt_1");
  });

  it("throws on HTTP error without echoing secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    try {
      await listAgents("http://host", "super-secret-token");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AifrostClientError);
      expect(String((err as Error).message)).not.toContain("super-secret-token");
    }
  });

  it("includes server error.message in client error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "bad token" },
            }),
            { status: 401 },
          ),
      ),
    );
    await expect(listAgents("http://host", "tok")).rejects.toThrow(
      /HTTP 401 \(unauthorized\) bad token/,
    );
  });

  it("rejects malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ object: "list" })),
    );
    await expect(listAgents("http://host", "tok")).rejects.toThrow(/data/);
  });
});

describe("createAgent", () => {
  it("POSTs body and returns agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://host/v1/agents");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        provider: "chatgpt-web",
        account_id: "acct_main",
      });
      return jsonResponse({
        id: "agt_new",
        provider: "chatgpt-web",
        account_id: "acct_main",
        lifecycle: "ready",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent("http://host", "tok", {
      provider: "chatgpt-web",
      account_id: "acct_main",
    });
    expect(agent.id).toBe("agt_new");
  });
});
