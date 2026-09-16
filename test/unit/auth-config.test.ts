import { describe, expect, it } from "vitest";
import { enforceAuth, isLoopbackHost, resolveAuthConfig } from "../../src/api/auth.js";
import { AifrostException } from "../../src/types/errors.js";

describe("resolveAuthConfig", () => {
  it("defaults to bearer with default token when provided", () => {
    const c = resolveAuthConfig({}, { token: "dev-token-change-me" });
    expect(c).toEqual({ mode: "bearer", token: "dev-token-change-me" });
  });

  it("parses AIFROST_AUTH=none aliases", () => {
    for (const v of ["none", "off", "disabled", "false", "0"]) {
      expect(resolveAuthConfig({ AIFROST_AUTH: v }).mode).toBe("none");
    }
  });

  it("reads bearer token from env", () => {
    expect(
      resolveAuthConfig({
        AIFROST_AUTH: "bearer",
        AIFROST_AUTH_TOKEN: " secret ",
      }),
    ).toEqual({ mode: "bearer", token: "secret" });
  });
});

describe("enforceAuth", () => {
  it("no-ops when mode is none", () => {
    expect(() => enforceAuth({ headers: {} } as never, { mode: "none", token: "" })).not.toThrow();
  });

  it("requires bearer when enabled", () => {
    try {
      enforceAuth({ headers: {} } as never, { mode: "bearer", token: "tok" });
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AifrostException);
      expect((e as AifrostException).httpStatus).toBe(401);
    }
  });

  it("accepts matching bearer", () => {
    expect(() =>
      enforceAuth({ headers: { authorization: "Bearer tok" } } as never, {
        mode: "bearer",
        token: "tok",
      }),
    ).not.toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("detects loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
