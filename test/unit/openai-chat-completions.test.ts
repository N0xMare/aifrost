import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/types/agent.js";
import type { NormalizedMessage } from "../../src/types/messages.js";
import { textContent } from "../../src/types/messages.js";
import { AifrostException } from "../../src/types/errors.js";
import type { AgentId, GenerationId, MessageId } from "../../src/types/ids.js";
import {
  encodeChatCompletion,
  encodeChatCompletionStream,
  encodeChatCompletionsError,
  parseChatCompletionsRequest,
} from "../../src/protocols/openai/chat-completions.js";
import type { CanonicalGenerationEvent } from "../../src/types/events.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "agt_testagent000001" as AgentId,
    providerId: "fixture-web",
    accountId: "acct_default" as Agent["accountId"],
    lifecycle: "ready",
    activity: "idle",
    auth: "authenticated",
    settings: {
      desired: { model_or_mode: "fixture-fast" },
      effective: { model_or_mode: "fixture-fast" },
      revision: 1,
      observedAt: now,
      capabilitiesRevision: "cap_fixture_1",
    },
    conversation: {
      providerConversationId: "conv_1",
      providerUrl: null,
      title: null,
      turnCount: 0,
      historyRevision: 0,
      fingerprint: null,
    },
    currentGenerationId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides,
  };
}

function msg(
  role: NormalizedMessage["role"],
  text: string,
  agentId: AgentId = "agt_testagent000001" as AgentId,
): NormalizedMessage {
  return {
    id: `msg_${role}_${text.slice(0, 8)}` as MessageId,
    agentId,
    providerMessageId: null,
    role,
    content: [textContent(text)],
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

async function collectStream(
  events: CanonicalGenerationEvent[],
  model = "fixture-fast",
): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const u8 of encodeChatCompletionStream(
    (async function* () {
      for (const e of events) yield e;
    })(),
    { model, generationId: "gen_abc123" },
  )) {
    chunks.push(decoder.decode(u8));
  }
  return chunks.join("");
}

describe("openai chat completions parse + reconcile", () => {
  it("empty history: system + user (Pi style) becomes user turn only", () => {
    const agent = makeAgent();
    const req = parseChatCompletionsRequest(
      {
        model: "gpt-whatever-client-says",
        messages: [
          { role: "system", content: "You are a coding assistant with tools." },
          { role: "user", content: "hello" },
        ],
        stream: false,
      },
      agent,
      { history: [] },
    );
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("multi-turn with leading system still reconciles", () => {
    const agent = makeAgent();
    const history = [msg("user", "hello"), msg("assistant", "Echo: hello")];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "hello" },
          { role: "assistant", content: "Echo: hello" },
          { role: "user", content: "next" },
        ],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "next" }]);
  });

  it("empty history: single user message becomes new turn", () => {
    const agent = makeAgent();
    const req = parseChatCompletionsRequest(
      {
        model: "gpt-whatever-client-says",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      agent,
      { history: [] },
    );
    expect(req.sourceProtocol).toBe("openai.chat.completions");
    expect(req.stream).toBe(false);
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.role).toBe("user");
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "hello" }]);
    // model must NOT appear as requestedSettings mutation
    expect(req.requestedSettings).toEqual({});
    expect(req.metadata.openai).toMatchObject({
      model_label: "fixture-fast",
      requested_model: "gpt-whatever-client-says",
    });
  });

  it("history prefix match submits only suffix", () => {
    const agent = makeAgent();
    const history = [msg("user", "ping"), msg("assistant", "Echo: ping")];
    const req = parseChatCompletionsRequest(
      {
        model: "fixture-fast",
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "Echo: ping" },
          { role: "user", content: "pong" },
        ],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "pong" }]);
    expect(req.messages).toHaveLength(3);
  });

  it("diverging history is stateful-continued by default (last user)", () => {
    const agent = makeAgent();
    const history = [msg("user", "A"), msg("assistant", "B")];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "A" },
          { role: "assistant", content: "X" },
          { role: "user", content: "E" },
        ],
      },
      agent,
      { history },
    );
    expect(req.metadata.history_reconcile).toBe("stateful");
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "E" }]);
  });

  it("strict mode still 409s on diverge", () => {
    const prev = process.env.AIFROST_HISTORY_MODE;
    process.env.AIFROST_HISTORY_MODE = "strict";
    try {
      const agent = makeAgent();
      const history = [msg("user", "A"), msg("assistant", "B")];
      expect(() =>
        parseChatCompletionsRequest(
          {
            messages: [
              { role: "user", content: "A" },
              { role: "assistant", content: "X" },
              { role: "user", content: "E" },
            ],
          },
          agent,
          { history },
        ),
      ).toThrow(AifrostException);
    } finally {
      if (prev === undefined) delete process.env.AIFROST_HISTORY_MODE;
      else process.env.AIFROST_HISTORY_MODE = prev;
    }
  });

  it("strips tools params and accepts request", () => {
    const agent = makeAgent();
    const req = parseChatCompletionsRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", parameters: {} },
          },
        ],
        tool_choice: "auto",
      },
      agent,
      { history: [] },
    );
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "hi" }]);
    // tools[] captured for tool_calls façade (stripped from WebUI path only)
    expect(req.tools).toEqual([
      {
        name: "get_weather",
        description: undefined,
        parameters: {},
        kind: "client_function",
      },
    ]);
  });

  it("projects full tool loop (tool_calls dropped, tool results as turn)", () => {
    const agent = makeAgent();
    const history = [msg("user", "fix bug"), msg("assistant", "need file")];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "fix bug" },
          { role: "assistant", content: "need file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            name: "read_file",
            content: "export const x = 1",
          },
        ],
        tools: [{ type: "function", function: { name: "read_file" } }],
        tool_choice: "auto",
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages).toHaveLength(1);
    const text = (req.newTurnMessages[0]!.content[0] as { text: string }).text;
    expect(text).toContain("[tool_result name=read_file id=call_1]");
    expect(text).toContain("export const x = 1");
    // Must NOT re-paste the original user request into the tool continue turn
    expect(text).not.toMatch(/^fix bug/);
  });

  it("tool continue omits original user when suffix has plain+tool (WebUI already has it)", () => {
    const agent = makeAgent();
    // After tool_calls façade, server history is empty / no provisional user
    const history: NormalizedMessage[] = [];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "generate hex and list files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "bash",
                  arguments: '{"command":"openssl rand -hex 8"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            name: "bash",
            content: "a1b2c3d4e5f60708",
          },
        ],
        tools: [{ type: "function", function: { name: "bash" } }],
      },
      agent,
      { history },
    );
    const text = (req.newTurnMessages[0]!.content[0] as { text: string }).text;
    expect(text).toContain("[tool_result");
    expect(text).toContain("a1b2c3d4e5f60708");
    expect(text).not.toContain("generate hex and list files");
  });

  it("joins multiple tool_result observations in one turn", () => {
    const agent = makeAgent();
    const history = [msg("user", "q"), msg("assistant", "a")];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
          { role: "tool", name: "t1", content: "r1" },
          { role: "tool", name: "t2", content: "r2" },
        ],
      },
      agent,
      { history },
    );
    const text = (req.newTurnMessages[0]!.content[0] as { text: string }).text;
    expect(text).toContain("r1");
    expect(text).toContain("r2");
    expect(text).toContain("\n\n");
  });

  it("multi-tool joined history remains a prefix on next request", () => {
    const agent = makeAgent();
    const toolJoined = "[tool_result name=t1]\nr1\n\n[tool_result name=t2]\nr2";
    const history = [
      msg("user", "q"),
      msg("assistant", "a"),
      msg("user", toolJoined),
      msg("assistant", "used both"),
    ];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
          { role: "tool", name: "t1", content: "r1" },
          { role: "tool", name: "t2", content: "r2" },
          { role: "assistant", content: "used both" },
          { role: "user", content: "next" },
        ],
        tools: [{ type: "function", function: { name: "t1" } }],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "next" }]);
  });

  it("fuzzy-matches assistant when client has user-prefix glue", () => {
    const agent = makeAgent();
    const history = [
      msg("user", "test"),
      msg("assistant", "Test received — everything's working."),
    ];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            content: "testTest received — everything's working.",
          },
          { role: "user", content: "please list files" },
        ],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "please list files" }]);
  });

  it("stateful fallback: client omits prior turns still continues with last user", () => {
    const agent = makeAgent();
    const history = [
      msg("user", "first question about ls"),
      msg("assistant", "Yep here is a tree of /"),
    ];
    // Pi-like: only the new user line (or rewritten transcript) — not a prefix
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "now write a poem that is ~100 words" },
        ],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([
      { type: "text", text: "now write a poem that is ~100 words" },
    ]);
    expect(req.metadata.history_reconcile).toBe("stateful");
  });

  it("flexible match: stored tool_result user matches split tool messages", () => {
    const agent = makeAgent();
    // After tool-only continue, stored history is tool_result text only
    const joined = "[tool_result name=bash id=c1]\nok";
    const history = [
      msg("user", "list files"),
      msg("user", joined),
      msg("assistant", "Echo: done"),
    ];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: { name: "bash", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "c1",
            name: "bash",
            content: "ok",
          },
          { role: "assistant", content: "Echo: done" },
          { role: "user", content: "next please" },
        ],
      },
      agent,
      { history },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "next please" }]);
  });

  it("orphaned last user (failed gen) can be re-driven without empty suffix", () => {
    const agent = makeAgent();
    const toolText = "[tool_result name=bash id=c1]\nok";
    const history = [msg("user", toolText)];
    const req = parseChatCompletionsRequest(
      {
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: { name: "bash", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "c1",
            name: "bash",
            content: "ok",
          },
        ],
      },
      agent,
      { history },
    );
    const text = (req.newTurnMessages[0]!.content[0] as { text: string }).text;
    expect(text).toContain("[tool_result name=bash id=c1]");
    expect(text).toContain("ok");
  });

  it("rejects image content parts", () => {
    const agent = makeAgent();
    expect(() =>
      parseChatCompletionsRequest(
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "see" },
                { type: "image_url", image_url: { url: "https://x" } },
              ],
            },
          ],
        },
        agent,
        { history: [] },
      ),
    ).toThrow(AifrostException);
  });

  it("array content parts join to text", () => {
    const agent = makeAgent();
    const req = parseChatCompletionsRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        ],
      },
      agent,
      { history: [] },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "hello world" }]);
  });
});

describe("openai chat completions encode", () => {
  const generationId = "gen_encode001" as GenerationId;

  it("non-streaming golden shape omits fabricated usage", () => {
    const encoded = encodeChatCompletion(
      {
        generationId,
        messages: [msg("assistant", "Echo: hi", "agt_testagent000001" as AgentId)],
      },
      { model: "fixture-fast", created: 1_700_000_000 },
    );
    expect(encoded.status).toBe(200);
    expect(encoded.body).toEqual({
      id: "chatcmpl_encode001",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "fixture-fast",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Echo: hi",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: null,
      usage_available: false,
    });
  });

  it("streaming golden SSE chunks + [DONE]", async () => {
    const sse = await collectStream([
      { type: "generation.created", generationId },
      { type: "generation.started", generationId },
      { type: "output_text.delta", generationId, delta: "Echo: " },
      { type: "output_text.delta", generationId, delta: "hi" },
      {
        type: "generation.completed",
        generationId,
        messages: [msg("assistant", "Echo: hi")],
      },
    ]);

    expect(sse).toContain("data: ");
    expect(sse).toContain('"object":"chat.completion.chunk"');
    expect(sse).toContain('"content":"Echo: "');
    expect(sse).toContain('"content":"hi"');
    expect(sse).toContain('"finish_reason":"stop"');
    expect(sse).toContain("data: [DONE]");
    expect(sse).toContain('"usage":null');
    expect(sse).toContain('"usage_available":false');
  });

  it("encodeError maps history conflict to OpenAI envelope", () => {
    const encoded = encodeChatCompletionsError({
      code: "agent_history_conflict",
      message: "diverged",
      retryable: false,
      agentId: "agt_x" as AgentId,
    });
    expect(encoded.status).toBe(409);
    const body = encoded.body as {
      error: { code: string; message: string; aifrost: { code: string } };
    };
    expect(body.error.code).toBe("agent_history_conflict");
    expect(body.error.aifrost.code).toBe("agent_history_conflict");
  });
});
