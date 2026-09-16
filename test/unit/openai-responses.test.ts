import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/types/agent.js";
import type { NormalizedMessage } from "../../src/types/messages.js";
import { textContent } from "../../src/types/messages.js";
import { AifrostException } from "../../src/types/errors.js";
import type { AgentId, GenerationId, MessageId } from "../../src/types/ids.js";
import {
  encodeResponse,
  encodeResponseStream,
  encodeResponsesError,
  parseResponsesRequest,
} from "../../src/protocols/openai/responses.js";
import type { CanonicalGenerationEvent } from "../../src/types/events.js";

function makeAgent(): Agent {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "agt_testagent000001" as AgentId,
    providerId: "fixture-web",
    accountId: "acct_default" as Agent["accountId"],
    lifecycle: "ready",
    activity: "idle",
    auth: "authenticated",
    settings: {
      desired: { model_or_mode: "fixture-default" },
      effective: { model_or_mode: "fixture-default" },
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
  };
}

function assistantMsg(text: string): NormalizedMessage {
  return {
    id: "msg_asst1" as MessageId,
    agentId: "agt_testagent000001" as AgentId,
    providerMessageId: null,
    role: "assistant",
    content: [textContent(text)],
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

async function collectStream(events: CanonicalGenerationEvent[]): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const u8 of encodeResponseStream(
    (async function* () {
      for (const e of events) yield e;
    })(),
    { model: "fixture-default", generationId: "gen_resp001" },
  )) {
    chunks.push(decoder.decode(u8));
  }
  return chunks.join("");
}

describe("openai responses parse", () => {
  it("string input becomes user turn; model is label only", () => {
    const agent = makeAgent();
    const req = parseResponsesRequest(
      { model: "gpt-4o", input: "hello responses", stream: false },
      agent,
      { history: [] },
    );
    expect(req.sourceProtocol).toBe("openai.responses");
    expect(req.newTurnMessages).toHaveLength(1);
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "hello responses" }]);
    expect(req.requestedSettings).toEqual({});
    expect(req.metadata.openai).toMatchObject({
      model_label: "fixture-default",
      requested_model: "gpt-4o",
    });
  });

  it("array input with message items", () => {
    const agent = makeAgent();
    const req = parseResponsesRequest(
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "array hi" }],
          },
        ],
      },
      agent,
      { history: [] },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "array hi" }]);
  });

  it("extracts tools into canonical defs for the prompt-engineered façade", () => {
    const agent = makeAgent();
    const req = parseResponsesRequest(
      {
        input: "x",
        tools: [{ type: "function", name: "f", parameters: {} }],
        tool_choice: "required",
      },
      agent,
      { history: [] },
    );
    expect(req.newTurnMessages[0]!.content).toEqual([{ type: "text", text: "x" }]);
    expect(req.tools).toEqual([
      {
        name: "f",
        description: undefined,
        parameters: {},
        kind: "client_function",
      },
    ]);
  });

  it("projects function_call_output into a tool_result observation", () => {
    const agent = makeAgent();
    const req = parseResponsesRequest(
      {
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: '{"temp_c":18}',
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "continue" }],
          },
        ],
      },
      agent,
      { history: [] },
    );
    // function_call items are dropped (assistant's own intents); the output
    // becomes a projected [tool_result] observation in the user turn.
    const text = req.newTurnMessages
      .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
      .join("\n");
    expect(text).toContain("[tool_result id=call_1]");
    expect(text).toContain('{"temp_c":18}');
    expect(text).toContain("continue");
    expect(text).not.toContain("get_weather");
  });

  it("rejects missing input", () => {
    const agent = makeAgent();
    expect(() => parseResponsesRequest({ model: "x" }, agent, { history: [] })).toThrow(
      AifrostException,
    );
  });
});

describe("openai responses encode", () => {
  const generationId = "gen_resp001" as GenerationId;

  it("non-streaming golden shape", () => {
    const encoded = encodeResponse(
      {
        generationId,
        messages: [assistantMsg("Echo: hi")],
      },
      { model: "fixture-default", created: 1_700_000_000 },
    );
    expect(encoded.status).toBe(200);
    const body = encoded.body as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "resp_resp001",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: "fixture-default",
      usage: null,
      usage_available: false,
    });
    const output = body.output as Array<{
      type: string;
      content: Array<{ type: string; text: string }>;
    }>;
    expect(output[0]!.type).toBe("message");
    expect(output[0]!.content[0]).toEqual({
      type: "output_text",
      text: "Echo: hi",
      annotations: [],
    });
  });

  it("emits function_call output items from prompt-engineered toolIntents", () => {
    const encoded = encodeResponse(
      {
        generationId,
        messages: [],
        toolIntents: [
          {
            id: "call_tc1",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
      { model: "fixture-default", created: 1_700_000_000 },
    );
    const output = (encoded.body as Record<string, unknown>).output as Array<
      Record<string, unknown>
    >;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: "function_call",
      name: "get_weather",
      call_id: "call_tc1",
    });
    expect(JSON.parse(String(output[0]!.arguments))).toEqual({
      city: "Paris",
    });
  });

  it("streaming emits response.function_call_arguments.* for toolIntents", async () => {
    const sse = await collectStream([
      { type: "generation.created", generationId },
      { type: "generation.started", generationId },
      {
        type: "generation.completed",
        generationId,
        messages: [],
        toolIntents: [{ id: "call_tc9", name: "ls", arguments: { path: "." } }],
      },
    ]);
    expect(sse).toContain("response.output_item.added");
    expect(sse).toContain('"type":"function_call"');
    expect(sse).toContain("response.function_call_arguments.delta");
    expect(sse).toContain("response.function_call_arguments.done");
    expect(sse).toContain("response.completed");
  });

  it("streaming emits response.* events", async () => {
    const sse = await collectStream([
      { type: "generation.created", generationId },
      { type: "generation.started", generationId },
      { type: "output_text.delta", generationId, delta: "Echo: " },
      { type: "output_text.delta", generationId, delta: "hi" },
      {
        type: "generation.completed",
        generationId,
        messages: [assistantMsg("Echo: hi")],
      },
    ]);
    expect(sse).toContain("event: response.created");
    expect(sse).toContain("event: response.output_text.delta");
    expect(sse).toContain('"delta":"Echo: "');
    expect(sse).toContain("event: response.completed");
    expect(sse).toContain('"usage":null');
  });

  it("encodeError for unsupported_parameter", () => {
    const encoded = encodeResponsesError({
      code: "unsupported_parameter",
      message: "no tools",
      retryable: false,
      details: { param: "tools" },
    });
    expect(encoded.status).toBe(422);
    expect((encoded.body as { error: { code: string } }).error.code).toBe("unsupported_parameter");
  });
});
