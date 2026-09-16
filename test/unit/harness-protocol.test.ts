import { describe, expect, it } from "vitest";
import {
  buildStickyProtocolV1,
  compactToolDescription,
  composeHarnessTurnV1,
  encodeToolCatalogToon,
  looksLikeAifrostToolRefusal,
  looksLikeChatGptProductSandbox,
  looksLikeProseOnlyRequest,
  looksLikeStrongProductSandbox,
  measureHarnessWrap,
  resolveHarnessProtocolMode,
  stripAifrostToolBlocksForSandboxScan,
  stripHarnessPeEcho,
  toolCatalogFingerprint,
  toolParamKeys,
  userLikelyNeedsHostTools,
} from "../../src/protocols/openai/harness-protocol.js";
import {
  buildHarnessToolInstruction,
  tryParseToolScaffold,
  wrapUserTextForHarnessTools,
} from "../../src/protocols/openai/tool-intents.js";
import type { CanonicalToolDefinition } from "../../src/types/generation.js";

const piTools: CanonicalToolDefinition[] = [
  {
    name: "bash",
    kind: "client_function",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    kind: "client_function",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    kind: "client_function",
    description: "Edit a single file using exact text replacement.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: { type: "array" },
      },
    },
  },
  {
    name: "write",
    kind: "client_function",
    description: "Write content to a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
];

describe("resolveHarnessProtocolMode", () => {
  it("defaults to compact", () => {
    expect(resolveHarnessProtocolMode({})).toBe("compact");
  });
  it("legacy aliases", () => {
    expect(resolveHarnessProtocolMode({ AIFROST_HARNESS_PROTOCOL: "legacy" })).toBe("legacy");
  });
});

describe("encodeToolCatalogToon", () => {
  it("emits tabular header and rows without full JSON schemas", () => {
    const cat = encodeToolCatalogToon(piTools);
    expect(cat).toMatch(/^tools\[4\]\{name,desc,keys\}:/);
    expect(cat).toContain("bash,");
    expect(cat).toContain("command|timeout");
    expect(cat).not.toContain('"type":"object"');
    expect(cat).not.toContain("parameters schema");
  });

  it("extracts param keys", () => {
    expect(toolParamKeys(piTools[0]!.parameters)).toEqual(["command", "timeout"]);
  });

  it("truncates long descriptions", () => {
    expect(compactToolDescription("a".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("composeHarnessTurnV1", () => {
  it("is much smaller than legacy wrap for the same tools", () => {
    const user = "list files and write chessboard.js";
    const compact = composeHarnessTurnV1(user, piTools);
    const legacy = wrapUserTextForHarnessTools(user, piTools, {
      AIFROST_HARNESS_PROTOCOL: "legacy",
    });
    const c = measureHarnessWrap(compact);
    const l = measureHarnessWrap(legacy);
    // Compact still well under legacy (sticky lift-note adds a bit of PE)
    expect(c.chars).toBeLessThan(l.chars * 0.75);
    expect(compact).toMatch(/AIFROST v1/);
    expect(compact).toMatch(/tools\[4\]/);
    expect(compact).toContain("U:");
    expect(compact).toContain(user);
    expect(compact).not.toMatch(/ls\s+-la/);
    expect(legacy.length).toBeGreaterThan(compact.length);
  });

  it("tool continue is short and keeps tool_result body", () => {
    const tr = "[tool_result name=bash id=call_1]\nRANDOM_HEX=abc\n/Users/x/aifrost";
    const compact = composeHarnessTurnV1(tr, piTools);
    expect(compact).toMatch(/^TR HOST/i);
    expect(compact).toContain("tools:bash,read,edit,write");
    expect(compact).toContain("RANDOM_HEX=abc");
    expect(compact).not.toContain("parameters schema");
    // single tools list (no footer duplicate)
    expect(compact.match(/tools:/g)?.length).toBe(1);
    const legacy = wrapUserTextForHarnessTools(tr, piTools, {
      AIFROST_HARNESS_PROTOCOL: "legacy",
    });
    expect(compact.length).toBeLessThan(legacy.length);
  });

  it("default wrapUserTextForHarnessTools uses compact", () => {
    const w = wrapUserTextForHarnessTools("hello tools", piTools, {});
    expect(w).toMatch(/AIFROST v1/);
    expect(w).not.toMatch(/You are the reasoning model/);
  });
});

describe("sticky protocol", () => {
  it("retains AIFROST_TOOL grammar for parse compatibility", () => {
    const sticky = buildStickyProtocolV1(piTools);
    expect(sticky).toContain("AIFROST_TOOL name=<name>");
    expect(sticky).toContain("{json}");
    expect(
      tryParseToolScaffold('AIFROST_TOOL name=bash\n{"command":"openssl rand -hex 8"}')?.[0]?.name,
    ).toBe("bash");
  });

  it("fingerprint stable for same tools", () => {
    expect(toolCatalogFingerprint(piTools)).toBe(toolCatalogFingerprint([...piTools]));
  });
});

describe("legacy instruction", () => {
  it("still available and larger", () => {
    const leg = buildHarnessToolInstruction(piTools);
    const sticky = buildStickyProtocolV1(piTools);
    expect(leg.length).toBeGreaterThan(sticky.length);
  });
});

describe("sandbox / host-need detection", () => {
  it("flags ChatGPT product sandbox fingerprints", () => {
    expect(
      looksLikeChatGptProductSandbox("I looked at /openai/project and found .dockerenv under /"),
    ).toBe(true);
    expect(looksLikeChatGptProductSandbox("You're in /Users/x/dev/aifrost")).toBe(false);
  });

  it("does not flag host-local final prose that answers a dockerenv probe", () => {
    expect(
      looksLikeChatGptProductSandbox(
        "Host cwd is /Users/x/dev/aifrost. NO_DOCKERENV — no .dockerenv on the laptop.",
      ),
    ).toBe(false);
    expect(
      looksLikeChatGptProductSandbox(
        "Confirmed: .dockerenv does not exist. Path: /Users/x/dev/aifrost",
      ),
    ).toBe(false);
  });

  it("does not flag host AIFROST_TOOL that probes .dockerenv (8.1 adversarial)", () => {
    const hostProbe = 'AIFROST_TOOL name=bash\n{"command":"ls -la / && cat /.dockerenv"}';
    expect(looksLikeChatGptProductSandbox(hostProbe)).toBe(false);
    expect(stripAifrostToolBlocksForSandboxScan(hostProbe).trim()).toBe("");
  });

  it("still flags prose sandbox when mixed with tool example text", () => {
    expect(
      looksLikeChatGptProductSandbox(
        "I used the remote interpreter in /openai/project with .dockerenv\n" +
          'AIFROST_TOOL name=bash\n{"command":"pwd"}',
      ),
    ).toBe(true);
  });

  it("strong product sandbox ignores mere .dockerenv restatement", () => {
    expect(looksLikeStrongProductSandbox("No .dockerenv; host path /Users/x/dev/aifrost")).toBe(
      false,
    );
    expect(looksLikeStrongProductSandbox("I inspected /openai/project and caas_toolbox ran")).toBe(
      true,
    );
  });

  it("detects host-tool-needed user asks", () => {
    expect(
      userLikelyNeedsHostTools("investigate this directory and write a chessboard js script"),
    ).toBe(true);
    expect(userLikelyNeedsHostTools("hello there")).toBe(false);
  });

  it("does not treat tool_result observations as needs-host (loop fix)", () => {
    const tr = "[tool_result name=bash id=c1]\n/Users/x/dev/aifrost\nscripts/foo.js\n";
    expect(userLikelyNeedsHostTools(tr)).toBe(false);
  });

  it("detects AIFROST_TOOL refusal from ChatGPT", () => {
    expect(
      looksLikeAifrostToolRefusal(
        "I can’t emit or execute AIFROST_TOOL blocks because those are not tools available in this ChatGPT environment.",
      ),
    ).toBe(true);
    expect(looksLikeAifrostToolRefusal("I can’t perform the write inROST_TOOL` output.")).toBe(
      true,
    );
    expect(looksLikeAifrostToolRefusal("Hello! I’m here.")).toBe(false);
  });

  it("prose-only requests skip tool PE", () => {
    expect(
      looksLikeProseOnlyRequest(
        "Reply with exactly one line: aifrost-protocol-ok\nDo not use any tools.",
      ),
    ).toBe(true);
    const wrap = composeHarnessTurnV1(
      "Reply with exactly one line: aifrost-protocol-ok. Do not use any tools.",
      piTools,
    );
    expect(wrap).toMatch(/PLAIN PROSE ONLY/);
    expect(wrap).not.toMatch(/tools\[\d+\]/);
  });

  it("sticky forbids product sandbox", () => {
    const s = buildStickyProtocolV1(piTools);
    expect(s).toMatch(/FORBIDDEN/i);
    expect(s).toMatch(/HOST-ONLY/i);
  });
});

describe("stripHarnessPeEcho", () => {
  it("strips sticky through U: (user line may remain for echo prefix strip)", () => {
    const wrap = composeHarnessTurnV1("hello", piTools);
    const echoed = `${wrap}\n\ndeadbeef`;
    const out = stripHarnessPeEcho(echoed);
    expect(out).toContain("deadbeef");
    expect(out).not.toMatch(/^AIFROST v1/);
    expect(out).not.toContain("tools[");
  });

  it("recovers AIFROST_TOOL after U: wrap", () => {
    const wrap = composeHarnessTurnV1("run openssl", piTools);
    const tool = 'AIFROST_TOOL name=bash\n{"command":"openssl rand -hex 8"}';
    expect(stripHarnessPeEcho(`${wrap}\n${tool}`)).toContain("AIFROST_TOOL");
  });

  it("drops pure TR observation echo", () => {
    const tr = "[tool_result name=bash id=call_1]\nok";
    const wrap = composeHarnessTurnV1(tr, piTools);
    expect(stripHarnessPeEcho(wrap)).toBe("");
  });

  it("recovers final prose after TR wrap", () => {
    const tr = "[tool_result name=bash id=call_1]\nok";
    const wrap = composeHarnessTurnV1(tr, piTools);
    const out = stripHarnessPeEcho(`${wrap}\n\nHex is abcdef and done.`);
    expect(out).toMatch(/Hex is abcdef/);
    expect(out).not.toMatch(/^TR host/);
  });
});
