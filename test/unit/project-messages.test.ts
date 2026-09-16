import { describe, expect, it } from "vitest";
import {
  coalesceConsecutiveUsers,
  projectOpenAIMessage,
  projectOpenAIMessages,
  stripClientToolParams,
  truncateToolPayload,
  TOOL_PAYLOAD_MAX_CHARS,
} from "../../src/protocols/openai/project-messages.js";

describe("stripClientToolParams", () => {
  it("removes tools, functions, tool_choice, function_call, parallel_tool_calls", () => {
    const body = {
      model: "x",
      messages: [],
      tools: [{ type: "function", function: { name: "f" } }],
      functions: [{ name: "f" }],
      tool_choice: "auto",
      function_call: "auto",
      parallel_tool_calls: true,
    };
    stripClientToolParams(body);
    expect(body.tools).toBeUndefined();
    expect(body.functions).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.function_call).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.model).toBe("x");
  });

  it("leaves empty tools array", () => {
    const body: Record<string, unknown> = { tools: [] };
    stripClientToolParams(body);
    expect(body.tools).toEqual([]);
  });
});

describe("projectOpenAIMessage", () => {
  it("passes through user text; drops system/developer for history stability", () => {
    expect(projectOpenAIMessage({ role: "user", content: "hi" })).toEqual([
      { role: "user", text: "hi" },
    ]);
    expect(projectOpenAIMessage({ role: "system", content: "sys" })).toEqual([]);
    expect(projectOpenAIMessage({ role: "developer", content: "dev" })).toEqual([]);
  });

  it("Pi-style system + user projects to user only", () => {
    expect(
      projectOpenAIMessages([
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "hello" },
      ]),
    ).toEqual([{ role: "user", text: "hello" }]);
  });

  it("keeps assistant content only (ignores tool_calls for history stability)", () => {
    const out = projectOpenAIMessage({
      role: "assistant",
      content: "thinking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    });
    expect(out).toEqual([{ role: "assistant", text: "thinking" }]);
  });

  it("drops assistant with only tool_calls and no content", () => {
    expect(
      projectOpenAIMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("projects role:tool as user observation", () => {
    const out = projectOpenAIMessage({
      role: "tool",
      name: "read_file",
      tool_call_id: "call_1",
      content: "file body",
    });
    expect(out).toEqual([
      {
        role: "user",
        text: "[tool_result name=read_file id=call_1]\nfile body",
      },
    ]);
  });

  it("projects legacy function role", () => {
    const out = projectOpenAIMessage({
      role: "function",
      name: "f",
      content: "r",
    });
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.text).toContain("[tool_result name=f]");
    expect(out[0]!.text).toContain("r");
  });

  it("skips empty assistant", () => {
    expect(projectOpenAIMessage({ role: "assistant", content: "" })).toEqual([]);
    expect(projectOpenAIMessage({ role: "assistant", content: null })).toEqual([]);
  });
});

describe("projectOpenAIMessages", () => {
  it("is deterministic for a full tool loop transcript", () => {
    const messages = [
      { role: "user", content: "fix bug" },
      { role: "assistant", content: "need file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            function: { name: "read_file", arguments: '{"p":"x"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        name: "read_file",
        content: "code",
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "thanks" },
    ];
    const a = projectOpenAIMessages(messages);
    const b = projectOpenAIMessages(messages);
    expect(a).toEqual(b);
    // tool_calls-only assistant dropped; tool → user
    expect(a.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(a[2]!.text).toMatch(/^\[tool_result/);
  });

  it("coalesces parallel tool_results into one user turn", () => {
    const projected = projectOpenAIMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "tool", name: "t1", content: "r1" },
      { role: "tool", name: "t2", content: "r2" },
    ]);
    expect(projected.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(projected[2]!.text).toContain("[tool_result name=t1]");
    expect(projected[2]!.text).toContain("r1");
    expect(projected[2]!.text).toContain("\n\n");
    expect(projected[2]!.text).toContain("[tool_result name=t2]");
    expect(projected[2]!.text).toContain("r2");
  });
});

describe("coalesceConsecutiveUsers", () => {
  it("joins adjacent tool_result users only", () => {
    expect(
      coalesceConsecutiveUsers([
        { role: "user", text: "plain" },
        { role: "user", text: "[tool_result name=t1]\nr1" },
        { role: "user", text: "[tool_result name=t2]\nr2" },
        { role: "assistant", text: "c" },
        { role: "user", text: "d" },
      ]),
    ).toEqual([
      { role: "user", text: "plain" },
      {
        role: "user",
        text: "[tool_result name=t1]\nr1\n\n[tool_result name=t2]\nr2",
      },
      { role: "assistant", text: "c" },
      { role: "user", text: "d" },
    ]);
  });
});

describe("TOOL_PAYLOAD_MAX_CHARS", () => {
  it("is modest enough for WebUI composer/CDP", () => {
    expect(TOOL_PAYLOAD_MAX_CHARS).toBeLessThanOrEqual(16_384);
  });
});

describe("truncateToolPayload", () => {
  it("truncates over max", () => {
    const big = "x".repeat(TOOL_PAYLOAD_MAX_CHARS + 10);
    const t = truncateToolPayload(big);
    expect(t.length).toBeLessThanOrEqual(TOOL_PAYLOAD_MAX_CHARS);
    expect(t.length).toBeLessThan(big.length);
    expect(t).toContain("truncated by aifrost");
  });
});
