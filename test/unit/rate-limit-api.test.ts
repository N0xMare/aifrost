import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { buildServer } from "../../src/api/server.js";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { AccountRateLimitController } from "../../src/core/account-rate-limit.js";
import type { FastifyInstance } from "fastify";

describe("rate-limit HTTP", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("GET defaults and PATCH account override", async () => {
    const token = "tok";
    const browser = new MockBrowserBackend();
    const providers = createDefaultProviderRegistry();
    const limiter = new AccountRateLimitController({
      env: { AIFROST_RATE_LIMIT: "agentic" },
    });
    const agents = new AgentRegistry(browser, providers, null, limiter);
    app = await buildServer({ authToken: token, agents, providers, rateLimiter: limiter });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const h = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const g = await fetch(`${base}/v1/rate-limit`, { headers: h });
    expect(g.status).toBe(200);
    const gd = (await g.json()) as { mode: string; enabled: boolean };
    expect(gd.mode).toBe("agentic");
    expect(gd.enabled).toBe(true);

    const p = await fetch(`${base}/v1/accounts/acct_main/rate-limit`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ mode: "interactive", min_submit_gap_ms: 1234 }),
    });
    expect(p.status).toBe(200);
    const pd = (await p.json()) as {
      mode: string;
      policy: { min_submit_gap_ms: number };
    };
    expect(pd.mode).toBe("interactive");
    expect(pd.policy.min_submit_gap_ms).toBe(1234);
  });
});
