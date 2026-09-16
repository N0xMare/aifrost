import { describe, expect, it } from "vitest";
import {
  AccountRateLimitController,
  classifyRateLimitText,
  defaultPolicyFromEnv,
  looksLikeChatGptLayerARateLimit,
  mergePolicy,
  parseRateLimitMode,
  type AccountRateLimitOverride,
} from "../../src/core/account-rate-limit.js";
import { AifrostException } from "../../src/types/errors.js";

describe("parseRateLimitMode", () => {
  it("maps aliases to off", () => {
    expect(parseRateLimitMode("0")).toBe("off");
    expect(parseRateLimitMode("none")).toBe("off");
    expect(parseRateLimitMode("OFF")).toBe("off");
  });
  it("defaults unknown to agentic", () => {
    expect(parseRateLimitMode(undefined)).toBe("agentic");
    expect(parseRateLimitMode("wat")).toBe("agentic");
  });
});

describe("defaultPolicyFromEnv", () => {
  it("agentic defaults", () => {
    const p = defaultPolicyFromEnv({ AIFROST_RATE_LIMIT: "agentic" });
    expect(p.enabled).toBe(true);
    expect(p.minSubmitGapMs).toBe(10_000);
    expect(p.rollingMaxSubmits).toBe(24);
    expect(p.maxInflight).toBe(1);
  });
  it("smoke preset", () => {
    const p = defaultPolicyFromEnv({ AIFROST_RATE_LIMIT: "smoke" });
    expect(p.minSubmitGapMs).toBe(20_000);
    expect(p.rollingMaxSubmits).toBe(16);
  });
  it("off disables", () => {
    expect(defaultPolicyFromEnv({ AIFROST_RATE_LIMIT: "off" }).enabled).toBe(false);
  });
  it("numeric overrides", () => {
    const p = defaultPolicyFromEnv({
      AIFROST_RATE_LIMIT: "interactive",
      AIFROST_RATE_MIN_SUBMIT_GAP_MS: "1234",
    });
    expect(p.minSubmitGapMs).toBe(1234);
  });
});

describe("mergePolicy", () => {
  it("mode=off disables even if enabled true then overwritten", () => {
    const base = defaultPolicyFromEnv({ AIFROST_RATE_LIMIT: "agentic" });
    const m = mergePolicy(base, { mode: "off" });
    expect(m.enabled).toBe(false);
    expect(m.mode).toBe("off");
  });
  it("interactive preset then field override", () => {
    const base = defaultPolicyFromEnv({ AIFROST_RATE_LIMIT: "agentic" });
    const m = mergePolicy(base, { mode: "interactive", min_submit_gap_ms: 8000 });
    expect(m.mode).toBe("interactive");
    expect(m.minSubmitGapMs).toBe(8000);
    expect(m.rollingMaxSubmits).toBe(30);
  });
});

describe("looksLikeChatGptLayerARateLimit", () => {
  it("matches official banner", () => {
    expect(
      looksLikeChatGptLayerARateLimit(
        "You’re making requests too quickly. We’ve temporarily limited access to your conversations to protect your data.",
      ),
    ).toBe(true);
    expect(looksLikeChatGptLayerARateLimit("Hello!")).toBe(false);
  });
  it("classifies C vs A", () => {
    expect(classifyRateLimitText("Too many concurrent requests")).toBe("C");
    expect(classifyRateLimitText("You're making requests too quickly")).toBe("A");
  });
});

describe("AccountRateLimitController", () => {
  it("skips fixture-web", async () => {
    const c = new AccountRateLimitController({
      env: { AIFROST_RATE_LIMIT: "agentic" },
    });
    const lease = await c.acquire({
      accountId: "acct_x",
      providerId: "fixture-web",
    });
    expect(lease).toBeNull();
  });

  it("enforces min gap on WebUI submits not acquire", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const c = new AccountRateLimitController({
      env: {
        AIFROST_RATE_LIMIT: "agentic",
        AIFROST_RATE_MIN_SUBMIT_GAP_MS: "100",
        AIFROST_RATE_ROLLING_MAX_SUBMITS: "10",
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const a = await c.acquire({ accountId: "acct_main", providerId: "chatgpt-web" });
    expect(a).not.toBeNull();
    await c.beforeWebUiSubmit({ accountId: "acct_main", providerId: "chatgpt-web" });
    c.afterWebUiSubmit("acct_main", "chatgpt-web");
    await c.beforeWebUiSubmit({ accountId: "acct_main", providerId: "chatgpt-web" });
    expect(sleeps.some((s) => s > 0)).toBe(true);
    c.afterWebUiSubmit("acct_main", "chatgpt-web");
    a!.release();
  });

  it("denies during cooldown after noteLimited", async () => {
    const now = 5_000_000;
    const c = new AccountRateLimitController({
      env: {
        AIFROST_RATE_LIMIT: "agentic",
        AIFROST_RATE_COOLDOWN_MS: "5000",
        AIFROST_RATE_MIN_SUBMIT_GAP_MS: "0",
      },
      now: () => now,
      sleep: async () => undefined,
    });
    c.noteLimited("acct_main", "A");
    await expect(
      c.acquire({ accountId: "acct_main", providerId: "chatgpt-web" }),
    ).rejects.toBeInstanceOf(AifrostException);
    try {
      await c.acquire({ accountId: "acct_main", providerId: "chatgpt-web" });
    } catch (e) {
      expect(e).toBeInstanceOf(AifrostException);
      expect((e as AifrostException).error.code).toBe("rate_limited");
      expect((e as AifrostException).httpStatus).toBe(429);
    }
  });

  it("rolling budget deny", async () => {
    const now = 8_000_000;
    const c = new AccountRateLimitController({
      env: {
        AIFROST_RATE_LIMIT: "agentic",
        AIFROST_RATE_MIN_SUBMIT_GAP_MS: "0",
        AIFROST_RATE_ROLLING_MAX_SUBMITS: "2",
        AIFROST_RATE_ROLLING_WINDOW_MS: "60000",
      },
      now: () => now,
      sleep: async () => undefined,
    });
    const a = await c.acquire({ accountId: "acct_r", providerId: "chatgpt-web" });
    c.afterWebUiSubmit("acct_r", "chatgpt-web");
    a!.release();
    const b = await c.acquire({ accountId: "acct_r", providerId: "chatgpt-web" });
    c.afterWebUiSubmit("acct_r", "chatgpt-web");
    b!.release();
    await expect(
      c.beforeWebUiSubmit({ accountId: "acct_r", providerId: "chatgpt-web" }),
    ).rejects.toMatchObject({ error: { code: "rate_limited" } });
  });

  it("PATCH override persists via store", () => {
    const mem = new Map<string, AccountRateLimitOverride>();
    const c = new AccountRateLimitController({
      env: { AIFROST_RATE_LIMIT: "agentic" },
      store: {
        get: (id) => (mem.get(id) as never) ?? null,
        put: (id, p) => {
          mem.set(id, p);
        },
        delete: (id) => {
          mem.delete(id);
        },
        list: () => [],
      },
    });
    c.setOverride("acct_main", { mode: "interactive", min_submit_gap_ms: 777 });
    expect(c.policyFor("acct_main").minSubmitGapMs).toBe(777);
    expect(c.policyFor("acct_main").mode).toBe("interactive");
    c.clearOverride("acct_main");
    expect(c.policyFor("acct_main").minSubmitGapMs).toBe(10_000);
  });
});
