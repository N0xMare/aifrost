import { describe, expect, it } from "vitest";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt-web/adapter.js";
import type {
  BrowserSession,
  EvaluateResult,
  BrowserRuntimeInfo,
} from "../../src/browser/backend.js";
import type { ProviderPageContext } from "../../src/providers/contract.js";
import type { CanonicalGenerationRequest } from "../../src/types/generation.js";
import type { CanonicalGenerationEvent } from "../../src/types/events.js";
import type { AgentId, GenerationId, RuntimeId } from "../../src/types/ids.js";

/**
 * Scripted BrowserSession for ChatGptWebAdapter — no CDP needed.
 * Answers evaluate() calls by matching the expression's identifying substrings.
 */
class FakeSession implements BrowserSession {
  readonly runtimeId = "rt_fake" as RuntimeId;
  readonly agentId = "agt_fake" as AgentId;

  title = "ChatGPT";
  href = "https://chatgpt.com/";
  hasComposer = true;
  hasLoginHints = false;
  userMessages = 0;
  assistantText = "";
  /** SSE-ish capture buffer returned for the active generation. */
  bufferText = "";
  bufferDone = false;
  stopClicked = false;
  stopVisible = false;
  submittedTexts: string[] = [];

  info(): BrowserRuntimeInfo {
    return {
      runtimeId: this.runtimeId,
      agentId: this.agentId,
      health: "healthy",
      pid: null,
      cdpEndpoint: null,
      targetId: null,
      sessionId: null,
      pageGeneration: 1,
      bridgeVersion: null,
      providerBuildFingerprint: null,
    };
  }

  async navigate(url: string): Promise<void> {
    this.href = url;
  }
  async reload(): Promise<void> {}
  async addScriptOnNewDocument(): Promise<string> {
    return "script_1";
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    const e = expression;
    const v = (value: unknown): EvaluateResult => ({ value });

    // Snapshot read inside collectAssistantText (must precede arm match).
    if (e.includes("st.buffers[genId]")) {
      return v({ text: this.bufferText, done: this.bufferDone, error: null });
    }
    if (e.includes("startsWith(prefix")) return v(true); // clearStreamCapture
    if (e.includes("window.fetch = async function")) return v(true); // armStreamCapture

    // Submit click (contains send.click()) before generic send-button probes.
    if (e.includes("send.click()")) {
      this.userMessages += 1;
      this.bufferDone = true;
      return v({ ok: true, via: "click" });
    }
    // Stage text into composer.
    if (e.includes("insertText")) {
      const m = e.match(/\(function\(text\)\{[\s\S]*?\}\)\(("(?:\\.|[^"\\])*")\)/);
      if (m) {
        try {
          this.submittedTexts.push(JSON.parse(m[1]!));
        } catch {
          /* ignore */
        }
      }
      return v({ ok: true, staged: true, prompt: "ok" });
    }
    // cancel() clicks a stop button (btn.click() inside its expression)
    if (e.includes("btn.click()")) {
      this.stopClicked = true;
      return v(true);
    }
    if (e.includes('send-button"]:not')) return v(true); // SEND_READY_EXPR
    if (e.includes("stop-button")) return v(this.stopVisible); // STOP_BUTTON_EXPR

    if (e.includes('data-message-author-role="user"')) return v(this.userMessages);
    // Assistant DOM bubble only exists after a submit — otherwise the adapter
    // would treat a pre-set text as the *previous* turn's baseline.
    if (e.includes('data-message-author-role="assistant"')) {
      return v(this.userMessages > 0 ? this.assistantText : "");
    }

    if (e.includes("login-button")) return v(this.hasLoginHints);
    if (e.includes('data-testid="composer"')) return v(this.hasComposer);
    if (e.includes("requests too quickly")) return v(""); // rate-limit banner
    if (e.includes("document.scripts")) {
      return v(JSON.stringify({ t: this.title, s: [] }));
    }
    if (e.includes("document.title")) return v(this.title);
    if (e.includes("document.readyState")) return v("complete");
    if (e.includes("location.hostname")) return v("chatgpt.com");
    if (e.includes("location.href")) return v(this.href);
    return v(null);
  }
}

function makeCtx(session: FakeSession): ProviderPageContext {
  return {
    agentId: "agt_fake" as AgentId,
    providerId: "chatgpt-web",
    accountId: "acct_test",
    session,
    bridge: {
      invoke: async () => ({}),
      drain: async () => ({ events: [], latestSeq: 0, overflow: false }),
      acknowledge: async () => undefined,
    },
  };
}

function makeRequest(
  text: string,
  tools?: CanonicalGenerationRequest["tools"],
): CanonicalGenerationRequest {
  const agentId = "agt_fake" as AgentId;
  return {
    agentId,
    generationId: "gen_test1" as GenerationId,
    sourceProtocol: "native",
    messages: [],
    newTurnMessages: [
      {
        id: "msg_u1" as never,
        agentId,
        providerMessageId: null,
        role: "user",
        content: [{ type: "text", text }],
        createdAt: new Date().toISOString(),
        metadata: {},
      },
    ],
    stream: true,
    requestedSettings: {},
    tools: tools ?? [],
    responseFormat: null,
    metadata: {},
  };
}

async function collect(
  iter: AsyncIterable<CanonicalGenerationEvent>,
  onEvent?: (ev: CanonicalGenerationEvent) => void,
): Promise<CanonicalGenerationEvent[]> {
  const out: CanonicalGenerationEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    onEvent?.(ev);
  }
  return out;
}

function sseCapture(text: string): string {
  return `data: ${JSON.stringify({ p: "/message/content/parts/0", v: text })}\n\ndata: [DONE]\n\n`;
}

describe("ChatGptWebAdapter (fake session)", () => {
  it("fails fast with auth_expired when login is required", async () => {
    const adapter = new ChatGptWebAdapter();
    const session = new FakeSession();
    session.hasComposer = false;
    session.hasLoginHints = true;

    const events = await collect(adapter.generate(makeCtx(session), makeRequest("hi")));
    const failed = events.find((e) => e.type === "generation.failed");
    expect(failed).toBeTruthy();
    if (failed?.type === "generation.failed") {
      expect(failed.error.code).toBe("auth_expired");
    }
  });

  it("fails with invalid_request on empty input", async () => {
    const adapter = new ChatGptWebAdapter();
    const events = await collect(adapter.generate(makeCtx(new FakeSession()), makeRequest("   ")));
    const failed = events.find((e) => e.type === "generation.failed");
    if (failed?.type === "generation.failed") {
      expect(failed.error.code).toBe("invalid_request");
    } else {
      expect.unreachable("expected generation.failed");
    }
  });

  it("captures assistant text from the network stream and completes", async () => {
    const adapter = new ChatGptWebAdapter();
    const session = new FakeSession();
    session.bufferText = sseCapture("Hello from ChatGPT");
    session.assistantText = "Hello from ChatGPT";

    const events = await collect(adapter.generate(makeCtx(session), makeRequest("say hi")));
    const completed = events.find((e) => e.type === "generation.completed");
    expect(completed).toBeTruthy();
    if (completed?.type === "generation.completed") {
      expect(completed.messages[0]?.role).toBe("assistant");
    }
    const delta = events.find((e) => e.type === "output_text.delta");
    expect(delta?.type === "output_text.delta" && delta.delta).toContain("Hello from ChatGPT");
  });

  it("parses array-valued SSE patch ops", async () => {
    const adapter = new ChatGptWebAdapter();
    const session = new FakeSession();
    session.bufferText = `data: ${JSON.stringify({ p: "/message/content/parts", v: ["Hello ", "array"] })}\n\n`;
    session.assistantText = "Hello array";

    const events = await collect(adapter.generate(makeCtx(session), makeRequest("say hi")));
    const delta = events.find((e) => e.type === "output_text.delta");
    expect(delta?.type === "output_text.delta" && delta.delta).toContain("Hello array");
  });

  it("emits toolIntents when the model produces an AIFROST_TOOL block", async () => {
    const adapter = new ChatGptWebAdapter();
    const session = new FakeSession();
    session.bufferText = sseCapture('AIFROST_TOOL name=ls\n{"path":"."}');
    session.assistantText = 'AIFROST_TOOL name=ls\n{"path":"."}';

    const events = await collect(
      adapter.generate(
        makeCtx(session),
        makeRequest("list files", [{ name: "ls", parameters: {}, kind: "client_function" }]),
      ),
    );
    const completed = events.find((e) => e.type === "generation.completed");
    expect(completed?.type === "generation.completed" && completed.toolIntents).toBeTruthy();
    if (completed?.type === "generation.completed") {
      expect(completed.toolIntents?.[0]?.name).toBe("ls");
    }
  });

  it("reports generation.cancelled (not completed) after cancel()", async () => {
    const adapter = new ChatGptWebAdapter();
    const session = new FakeSession();
    session.bufferText = sseCapture("partial answer");
    session.assistantText = "partial answer";

    const events = await collect(
      adapter.generate(makeCtx(session), makeRequest("say hi")),
      (ev) => {
        if (ev.type === "generation.started") {
          void adapter.cancel(makeCtx(session), "gen_test1");
        }
      },
    );
    expect(events.some((e) => e.type === "generation.cancelled")).toBe(true);
    expect(events.some((e) => e.type === "generation.completed")).toBe(false);
  });
});
