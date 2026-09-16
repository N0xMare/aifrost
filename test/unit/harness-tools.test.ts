import { describe, expect, it } from "vitest";
import {
  looksLikePureChat,
  planHarnessToolIntents,
  resolveHarnessToolsMode,
} from "../../src/protocols/openai/harness-tools.js";

describe("looksLikePureChat", () => {
  it("detects short greetings", () => {
    expect(looksLikePureChat("hello")).toBe(true);
    expect(looksLikePureChat("test")).toBe(true);
    expect(looksLikePureChat("how are you?")).toBe(true);
  });

  it("detects coding / tool intent", () => {
    expect(looksLikePureChat("please list files with ls")).toBe(false);
    expect(looksLikePureChat("read package.json and summarize")).toBe(false);
    expect(looksLikePureChat("fix the bug in src/foo.ts")).toBe(false);
  });
});

describe("planHarnessToolIntents", () => {
  const tools = [
    { name: "bash", kind: "client_function" as const },
    { name: "read", kind: "client_function" as const },
  ];

  it("auto: pure chat → null", () => {
    expect(
      planHarnessToolIntents({
        userText: "hello",
        tools,
        mode: "auto",
      }),
    ).toBeNull();
  });

  it("auto: coding → tool_calls", () => {
    const intents = planHarnessToolIntents({
      userText: "list the directory with ls",
      tools,
      mode: "auto",
    });
    expect(intents?.[0]?.name).toBe("bash");
  });

  it("never: always null even for coding", () => {
    expect(
      planHarnessToolIntents({
        userText: "run ls",
        tools,
        mode: "never",
      }),
    ).toBeNull();
  });

  it("skips after tool_result", () => {
    expect(
      planHarnessToolIntents({
        userText: "[tool_result name=bash]\nok",
        tools,
        mode: "always",
      }),
    ).toBeNull();
  });
});

describe("resolveHarnessToolsMode", () => {
  it("defaults to auto", () => {
    expect(resolveHarnessToolsMode({})).toBe("auto");
  });
});
