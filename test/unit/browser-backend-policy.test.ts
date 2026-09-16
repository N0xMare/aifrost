import { describe, expect, it } from "vitest";
import {
  resolveBrowserIdleExit,
  resolveMaxTabsPerAccount,
} from "../../src/browser/chromium/backend.js";

describe("resolveMaxTabsPerAccount", () => {
  it("defaults to 10", () => {
    expect(resolveMaxTabsPerAccount({})).toBe(10);
  });

  it("parses env and clamps", () => {
    expect(resolveMaxTabsPerAccount({ AIFROST_MAX_TABS_PER_ACCOUNT: "3" })).toBe(3);
    expect(resolveMaxTabsPerAccount({ AIFROST_MAX_TABS_PER_ACCOUNT: "0" })).toBe(1);
    expect(resolveMaxTabsPerAccount({ AIFROST_MAX_TABS_PER_ACCOUNT: "999" })).toBe(50);
  });

  it("honors explicit override", () => {
    expect(resolveMaxTabsPerAccount({ AIFROST_MAX_TABS_PER_ACCOUNT: "10" }, 7)).toBe(7);
  });
});

describe("resolveBrowserIdleExit", () => {
  it("defaults to sticky (false)", () => {
    expect(resolveBrowserIdleExit({})).toBe(false);
  });

  it("enables on truthy env", () => {
    expect(resolveBrowserIdleExit({ AIFROST_BROWSER_IDLE_EXIT: "1" })).toBe(true);
    expect(resolveBrowserIdleExit({ AIFROST_BROWSER_IDLE_EXIT: "true" })).toBe(true);
  });
});
