import { describe, expect, it } from "vitest";
import { hasAuthToken, normalizeBaseUrl, resolveConfig } from "../extensions/config.js";

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeBaseUrl("http://127.0.0.1:8787///")).toBe("http://127.0.0.1:8787");
  });

  it("preserves path prefixes without trailing slash", () => {
    expect(normalizeBaseUrl("http://host/aifrost")).toBe("http://host/aifrost");
  });

  it("defaults empty to localhost", () => {
    expect(normalizeBaseUrl("")).toBe("http://127.0.0.1:8787");
    expect(normalizeBaseUrl("   ")).toBe("http://127.0.0.1:8787");
  });
});

describe("resolveConfig", () => {
  it("uses defaults when env is empty", () => {
    const cfg = resolveConfig({});
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8787");
    expect(cfg.authToken).toBe("");
    expect(cfg.authHeader).toBe(false);
    expect(cfg.defaultAgent).toBeUndefined();
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.modelFilter).toBe("chatgpt");
  });

  it("AIFROST_SHOW_FIXTURE=1 shows all models", () => {
    expect(resolveConfig({ AIFROST_SHOW_FIXTURE: "1" }).modelFilter).toBe("all");
  });

  it("reads all env vars", () => {
    const cfg = resolveConfig({
      AIFROST_URL: "http://10.0.0.2:9000/",
      AIFROST_AUTH_TOKEN: " secret-token ",
      AIFROST_DEFAULT_AGENT: "agt_abc",
      AIFROST_API: "openai-responses",
    });
    expect(cfg.baseUrl).toBe("http://10.0.0.2:9000");
    expect(cfg.authToken).toBe("secret-token");
    expect(cfg.authHeader).toBe(true);
    expect(cfg.defaultAgent).toBe("agt_abc");
    expect(cfg.api).toBe("openai-responses");
  });

  it("AIFROST_AUTH=none disables bearer even if token set", () => {
    const cfg = resolveConfig({
      AIFROST_AUTH: "none",
      AIFROST_AUTH_TOKEN: "secret",
    });
    expect(cfg.authToken).toBe("");
    expect(cfg.authHeader).toBe(false);
  });

  it("ignores invalid AIFROST_API values", () => {
    const cfg = resolveConfig({ AIFROST_API: "anthropic-messages" });
    expect(cfg.api).toBe("openai-completions");
  });

  it("treats blank default agent as undefined", () => {
    const cfg = resolveConfig({ AIFROST_DEFAULT_AGENT: "  " });
    expect(cfg.defaultAgent).toBeUndefined();
  });
});

describe("hasAuthToken", () => {
  it("is false for empty token", () => {
    expect(hasAuthToken(resolveConfig({}))).toBe(false);
  });

  it("is true when token present", () => {
    expect(hasAuthToken(resolveConfig({ AIFROST_AUTH_TOKEN: "x" }))).toBe(true);
  });
});
