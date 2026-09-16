import { describe, expect, it } from "vitest";
import {
  buildHarnessToolInstruction,
  extractClientToolDefinitions,
  looksLikeIncompleteToolScaffold,
  needsToolScaffoldRecovery,
  parseHostToolIntents,
  planFixtureToolIntents,
  shellCommandLooksRunnable,
  tryParseToolScaffold,
  tryParseToolScaffoldLenient,
  toolIntentsToOpenAIToolCalls,
} from "../../src/protocols/openai/tool-intents.js";
import { encodeChatCompletion } from "../../src/protocols/openai/chat-completions.js";
import type { GenerationId } from "../../src/types/ids.js";

describe("extractClientToolDefinitions", () => {
  it("reads OpenAI function tools", () => {
    const defs = extractClientToolDefinitions({
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "run shell",
            parameters: { type: "object" },
          },
        },
        {
          type: "function",
          function: { name: "read", parameters: {} },
        },
      ],
    });
    expect(defs.map((d) => d.name)).toEqual(["bash", "read"]);
    expect(defs[0]!.kind).toBe("client_function");
  });
});

describe("planFixtureToolIntents", () => {
  it("emits bash tool_call when tools present and no tool_result", () => {
    const intents = planFixtureToolIntents({
      userText: "list the repo",
      tools: [
        { name: "bash", kind: "client_function" },
        { name: "read", kind: "client_function" },
      ],
    });
    expect(intents).toHaveLength(1);
    expect(intents![0]!.name).toBe("bash");
    expect(intents![0]!.arguments).toMatchObject({
      command: expect.stringContaining("ls"),
    });
  });

  it("returns null after tool_result observations", () => {
    expect(
      planFixtureToolIntents({
        userText: "[tool_result name=bash id=c1]\nok",
        tools: [{ name: "bash", kind: "client_function" }],
      }),
    ).toBeNull();
  });

  it("parses AIFROST_TOOL scaffold", () => {
    const intents = planFixtureToolIntents({
      userText: 'AIFROST_TOOL name=read arguments={"path":"package.json"}',
      tools: [],
    });
    expect(intents).toHaveLength(1);
    expect(intents![0]!.name).toBe("read");
    expect(intents![0]!.arguments).toEqual({ path: "package.json" });
  });
});

describe("tryParseToolScaffold", () => {
  it("fail-closed on bad json", () => {
    expect(tryParseToolScaffold("AIFROST_TOOL name=bash arguments={not json")).toBeNull();
  });

  it("parses model PE blocks", () => {
    const intents = tryParseToolScaffold(
      'Sure.\nAIFROST_TOOL name=bash\n{"command":"openssl rand -hex 8"}\n',
    );
    expect(intents).toHaveLength(1);
    expect(intents![0]!.name).toBe("bash");
    expect(intents![0]!.arguments).toEqual({
      command: "openssl rand -hex 8",
    });
  });

  it("parses nested JSON args (write content with braces)", () => {
    const intents = tryParseToolScaffold(
      'AIFROST_TOOL name=write\n{"path":"x.js","content":"const o = {a:1};"}',
    );
    expect(intents).toHaveLength(1);
    expect(intents![0]!.name).toBe("write");
    expect(intents![0]!.arguments).toEqual({
      path: "x.js",
      content: "const o = {a:1};",
    });
  });
});

describe("looksLikeIncompleteToolScaffold", () => {
  it("detects truncated command JSON", () => {
    expect(
      looksLikeIncompleteToolScaffold('AIFROST_TOOL name=bash\n{"command":"openssl rand'),
    ).toBe(true);
  });

  it("false for complete parseable blocks", () => {
    expect(
      looksLikeIncompleteToolScaffold('AIFROST_TOOL name=bash\n{"command":"openssl rand -hex 8"}'),
    ).toBe(false);
  });

  it("false for plain prose", () => {
    expect(looksLikeIncompleteToolScaffold("deadbeef")).toBe(false);
  });
});

describe("shellCommandLooksRunnable", () => {
  it("accepts real host commands", () => {
    expect(shellCommandLooksRunnable("pwd")).toBe(true);
    expect(shellCommandLooksRunnable("ls -la")).toBe(true);
    expect(shellCommandLooksRunnable("find src -type f -name '*.ts'")).toBe(true);
    expect(shellCommandLooksRunnable("openssl rand -hex 16")).toBe(true);
    expect(shellCommandLooksRunnable("node -e 'console.log(1)'")).toBe(true);
    expect(shellCommandLooksRunnable("./scripts/aifrost-test-script.js")).toBe(true);
  });
  it("rejects live-smoke garbage", () => {
    expect(shellCommandLooksRunnable("').randomBytes(16).toString('hex'))\"")).toBe(false);
    expect(shellCommandLooksRunnable(" HEX STRING ===\\n'; openssl rand -hex 16")).toBe(false);
    expect(shellCommandLooksRunnable("_DOCKERENV")).toBe(false);
    expect(shellCommandLooksRunnable("HEX")).toBe(false);
  });
});

describe("parseHostToolIntents", () => {
  it("accepts complete bash", () => {
    const ok = parseHostToolIntents(
      'AIFROST_TOOL name=bash\n{"command":"pwd && echo NO_DOCKERENV"}',
    );
    expect(ok?.[0]?.name).toBe("bash");
    expect((ok?.[0]?.arguments as { command?: string }).command).toContain("pwd");
  });
  it("rejects complete JSON with garbage command", () => {
    expect(parseHostToolIntents('AIFROST_TOOL name=bash\n{"command":"_DOCKERENV"}')).toBeNull();
    expect(
      parseHostToolIntents(
        'AIFROST_TOOL name=bash\n{"command":"\').randomBytes(16).toString(\'hex\'))"}',
      ),
    ).toBeNull();
  });
  it("returns only the first valid tool", () => {
    const ok = parseHostToolIntents(
      'AIFROST_TOOL name=bash\n{"command":"pwd"}\nAIFROST_TOOL name=bash\n{"command":"ls"}',
    );
    expect(ok).toHaveLength(1);
    expect((ok![0]!.arguments as { command?: string }).command).toBe("pwd");
  });
});

describe("tryParseToolScaffoldLenient", () => {
  it("repairs missing closing brace when command is already runnable", () => {
    const intents = tryParseToolScaffoldLenient(
      'AIFROST_TOOL name=bash\n{"command":"pwd && echo NO_DOCKERENV"',
    );
    expect(intents?.[0]?.name).toBe("bash");
    expect((intents?.[0]?.arguments as { command?: string })?.command).toContain("pwd");
  });
  it("does not repair JS/capture fragments into tool_calls", () => {
    expect(
      parseHostToolIntents(
        'AIFROST_TOOL name=bash\n{"command":"\').randomBytes(16).toString(\'hex\'))"',
      ),
    ).toBeNull();
    expect(
      parseHostToolIntents(
        'AIFROST_TOOL name=bash\n{"command":" HEX STRING ===\\n\'; openssl rand -hex 16"',
      ),
    ).toBeNull();
  });
});

describe("needsToolScaffoldRecovery", () => {
  it("true for truncated or garbage AIFROST_TOOL, false for usable parse", () => {
    expect(needsToolScaffoldRecovery('AIFROST_TOOL name=bash\n{"command":"pwd"}')).toBe(false);
    expect(
      needsToolScaffoldRecovery('AIFROST_TOOL name=bash\n{"command":"\').randomBytes(16)"'),
    ).toBe(true);
    expect(needsToolScaffoldRecovery("AIFROST_TOOL name=bash")).toBe(true);
    expect(needsToolScaffoldRecovery('AIFROST_TOOL name=bash\n{"command":"_DOCKERENV"}')).toBe(
      true,
    );
    expect(needsToolScaffoldRecovery("hello")).toBe(false);
  });
});

describe("buildHarnessToolInstruction", () => {
  it("does not bias the model with a sample shell command", () => {
    const text = buildHarnessToolInstruction([
      { name: "bash", kind: "client_function", description: "run shell" },
    ]);
    expect(text).not.toMatch(/ls\s+-la/);
    expect(text).not.toMatch(/pwd\s*&&/);
    expect(text).toMatch(/AIFROST_TOOL/);
    expect(text).toMatch(/plain prose/i);
  });
});

describe("encodeChatCompletion tool_calls", () => {
  it("emits OpenAI tool_calls finish_reason", () => {
    const encoded = encodeChatCompletion(
      {
        generationId: "gen_tool1" as GenerationId,
        messages: [],
        toolIntents: [
          {
            id: "call_abc",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      { model: "fixture-default", created: 1 },
    );
    const body = encoded.body as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls: Array<{ function: { name: string; arguments: string } }>;
        };
      }>;
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    expect(body.choices[0]!.message.content).toBeNull();
    expect(body.choices[0]!.message.tool_calls[0]!.function.name).toBe("bash");
    expect(JSON.parse(body.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({
      command: "ls",
    });
  });
});

describe("toolIntentsToOpenAIToolCalls", () => {
  it("stringifies object arguments", () => {
    const calls = toolIntentsToOpenAIToolCalls([{ id: "call_1", name: "x", arguments: { a: 1 } }]);
    expect(calls[0]!.function.arguments).toBe('{"a":1}');
  });
});
