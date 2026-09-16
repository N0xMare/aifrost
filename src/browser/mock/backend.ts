import type {
  AgentRuntimeConfig,
  BrowserBackend,
  BrowserRuntimeInfo,
  BrowserSession,
  BrowserStartConfig,
  EvaluateResult,
} from "../backend.js";
import type { AgentId, RuntimeId } from "../../types/ids.js";
import { newRuntimeId } from "../../types/ids.js";

/**
 * Deterministic in-process browser for M1 / unit tests.
 * Simulates page globals and document-start scripts without a real browser.
 */
export class MockBrowserSession implements BrowserSession {
  readonly runtimeId: RuntimeId;
  readonly agentId: AgentId;
  private health: BrowserRuntimeInfo["health"] = "healthy";
  private pageGeneration = 1;
  private url: string;
  private scripts: string[] = [];
  /** Simulated page JS globals */
  private globals: Record<string, unknown> = {};
  private dead = false;

  constructor(runtimeId: RuntimeId, agentId: AgentId, startUrl: string, scripts: string[]) {
    this.runtimeId = runtimeId;
    this.agentId = agentId;
    this.url = startUrl;
    this.scripts = [...scripts];
    this.runDocumentStartScripts();
  }

  info(): BrowserRuntimeInfo {
    return {
      runtimeId: this.runtimeId,
      agentId: this.agentId,
      health: this.dead ? "dead" : this.health,
      pid: this.dead ? null : 1,
      cdpEndpoint: this.dead ? null : "mock://cdp",
      targetId: "mock-target",
      sessionId: "mock-session",
      pageGeneration: this.pageGeneration,
      bridgeVersion:
        (this.globals.__AIFROST_BRIDGE__ as { version?: string } | undefined)?.version ?? null,
      providerBuildFingerprint: null,
    };
  }

  async navigate(url: string): Promise<void> {
    this.assertAlive();
    this.url = url;
    this.pageGeneration += 1;
    this.globals = {};
    this.runDocumentStartScripts();
  }

  async reload(): Promise<void> {
    await this.navigate(this.url);
  }

  async evaluate(expression: string, _timeoutMs?: number): Promise<EvaluateResult> {
    this.assertAlive();
    try {
      // Restricted evaluator for mock bridge: only supports our known expressions.
      if (expression.includes("__AIFROST_BRIDGE__")) {
        const bridge = this.globals.__AIFROST_BRIDGE__ as MockBridge | undefined;
        if (!bridge) {
          return { value: null, exception: "bridge not installed" };
        }
        // Patterns used by host:
        // window.__AIFROST_BRIDGE__.drain(n, m)
        // window.__AIFROST_BRIDGE__.invoke(...)
        // window.__AIFROST_BRIDGE__.acknowledge(n)
        // window.__AIFROST_BRIDGE__.state()
        // JSON.stringify(window.__AIFROST_BRIDGE__.drain(...))
        const drainMatch = expression.match(/__AIFROST_BRIDGE__\.drain\((\d+)\s*,\s*(\d+)\)/);
        if (drainMatch) {
          const after = Number(drainMatch[1]);
          const max = Number(drainMatch[2]);
          return { value: bridge.drain(after, max) };
        }
        const ackMatch = expression.match(/__AIFROST_BRIDGE__\.acknowledge\((\d+)\)/);
        if (ackMatch) {
          bridge.acknowledge(Number(ackMatch[1]));
          return { value: true };
        }
        if (expression.includes(".state()")) {
          return { value: bridge.state() };
        }
        const invokeMatch = expression.match(/__AIFROST_BRIDGE__\.invoke\((.+)\)\s*$/);
        if (invokeMatch) {
          const raw = invokeMatch[1]!;
          // expression is typically: JSON.stringify(window.__AIFROST_BRIDGE__.invoke(...))
          // or just invoke({...})
          let cmdJson = raw;
          if (raw.startsWith("(") && raw.endsWith(")")) {
            cmdJson = raw.slice(1, -1);
          }
          // Host passes JSON.stringify(cmd) as argument string content
          const cmd = JSON.parse(cmdJson) as Record<string, unknown>;
          return { value: bridge.invoke(cmd) };
        }
        if (expression.includes("__AIFROST_BRIDGE__") && expression.includes("version")) {
          return { value: bridge.version };
        }
      }
      if (expression === "location.href" || expression === "window.location.href") {
        return { value: this.url };
      }
      return { value: null, exception: `unsupported mock evaluate: ${expression.slice(0, 80)}` };
    } catch (e) {
      return { value: null, exception: e instanceof Error ? e.message : String(e) };
    }
  }

  async addScriptOnNewDocument(source: string): Promise<string> {
    this.assertAlive();
    this.scripts.push(source);
    // Apply immediately for mock convenience if bridge not yet present
    this.installScript(source);
    return `script_${this.scripts.length}`;
  }

  /** Test helper: kill the mock runtime */
  kill(): void {
    this.dead = true;
    this.health = "dead";
  }

  /** Test helper: access bridge for direct fixture control */
  getBridge(): MockBridge | undefined {
    return this.globals.__AIFROST_BRIDGE__ as MockBridge | undefined;
  }

  private assertAlive(): void {
    if (this.dead) throw new Error("mock runtime is dead");
  }

  private runDocumentStartScripts(): void {
    for (const s of this.scripts) {
      this.installScript(s);
    }
  }

  private installScript(source: string): void {
    if (source.includes("__AIFROST_MOCK_BRIDGE_INSTALL__") || source.includes("createMockBridge")) {
      const bridge = createMockBridge();
      this.globals.__AIFROST_BRIDGE__ = bridge;
      return;
    }
    // If source is the real page-bridge bundle marker, install mock bridge too
    if (source.includes("__AIFROST_BRIDGE__") || source.includes("AIFROST_PAGE_BRIDGE")) {
      this.globals.__AIFROST_BRIDGE__ = createMockBridge();
    }
  }
}

export class MockBrowserBackend implements BrowserBackend {
  private sessions = new Map<RuntimeId, MockBrowserSession>();
  private started = false;

  async start(_config: BrowserStartConfig): Promise<void> {
    this.started = true;
  }

  async createRuntime(agent: AgentRuntimeConfig): Promise<BrowserSession> {
    if (!this.started) throw new Error("MockBrowserBackend not started");
    const id = newRuntimeId();
    const session = new MockBrowserSession(
      id,
      agent.agentId,
      agent.startUrl,
      agent.documentStartScripts ?? [],
    );
    this.sessions.set(id, session);
    return session;
  }

  async destroyRuntime(runtimeId: RuntimeId): Promise<void> {
    const s = this.sessions.get(runtimeId);
    if (s) {
      s.kill();
      this.sessions.delete(runtimeId);
    }
  }

  getRuntime(runtimeId: RuntimeId): BrowserSession | undefined {
    return this.sessions.get(runtimeId);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.destroyRuntime(id);
    }
    this.started = false;
  }
}

/** Minimal in-page bridge used by the fixture provider under MockBrowserBackend. */
export interface MockBridge {
  version: string;
  state(): { ready: boolean; providerId: string | null; seq: number };
  invoke(command: Record<string, unknown>): { accepted: boolean; result?: unknown };
  drain(
    afterSeq: number,
    maxEvents: number,
  ): {
    events: Array<{ seq: number; type: string; payload: unknown; timestamp: string }>;
    latestSeq: number;
    overflow: boolean;
  };
  acknowledge(seq: number): void;
  /** Fixture internals */
  _emit(type: string, payload: unknown): void;
  _getStore(): FixtureStore;
}

interface FixtureStore {
  settings: Record<string, unknown>;
  history: Array<{
    id: string;
    role: string;
    text: string;
  }>;
  conversationId: string | null;
  title: string | null;
  activeGenerationId: string | null;
  cancelRequested: boolean;
  streamTokens: string[];
}

export function createMockBridge(): MockBridge {
  let seq = 0;
  let acked = 0;
  const buffer: Array<{
    seq: number;
    type: string;
    payload: unknown;
    timestamp: string;
  }> = [];
  const store: FixtureStore = {
    settings: { model_or_mode: "fixture-default", reasoning: { effort: "medium" } },
    history: [],
    conversationId: null,
    title: null,
    activeGenerationId: null,
    cancelRequested: false,
    streamTokens: [],
  };

  const emit = (type: string, payload: unknown) => {
    seq += 1;
    buffer.push({
      seq,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  };

  emit("bridge.ready", { bridgeVersion: "0.1.0-mock" });

  const bridge: MockBridge = {
    version: "0.1.0-mock",
    state() {
      return { ready: true, providerId: "fixture-web", seq };
    },
    invoke(command) {
      const type = String(command.type ?? "");
      switch (type) {
        case "provider.detect":
          return {
            accepted: true,
            result: { providerId: "fixture-web", matched: true, buildFingerprint: "fixture-1" },
          };
        case "agent.inspect":
          return {
            accepted: true,
            result: {
              auth: "authenticated",
              ready: true,
              conversation: {
                providerConversationId: store.conversationId,
                title: store.title,
                turnCount: store.history.filter((m) => m.role === "user").length,
              },
              settings: { ...store.settings },
              providerBuildFingerprint: "fixture-1",
            },
          };
        case "agent.apply_settings": {
          const desired = (command.settings as Record<string, unknown>) ?? {};
          store.settings = { ...store.settings, ...desired };
          emit("settings.applied", {
            desired: store.settings,
            effective: store.settings,
            warnings: [],
          });
          return {
            accepted: true,
            result: {
              desired: store.settings,
              effective: { ...store.settings },
              warnings: [],
              mismatches: [],
            },
          };
        }
        case "conversation.new": {
          store.conversationId = `fix_conv_${Date.now()}`;
          store.title = "New fixture conversation";
          store.history = [];
          emit("conversation.changed", {
            providerConversationId: store.conversationId,
            title: store.title,
          });
          return {
            accepted: true,
            result: { providerConversationId: store.conversationId },
          };
        }
        case "conversation.open": {
          const ref = command.ref as { providerConversationId?: string };
          store.conversationId = ref.providerConversationId ?? store.conversationId;
          return { accepted: true, result: { providerConversationId: store.conversationId } };
        }
        case "generation.start": {
          const generationId = String(command.generationId);
          const inputText = String(command.inputText ?? "");
          store.activeGenerationId = generationId;
          store.cancelRequested = false;
          store.history.push({ id: `u_${generationId}`, role: "user", text: inputText });
          emit("generation.accepted", { generationId });
          // Prepare deterministic stream tokens
          const reply = `Echo: ${inputText}`;
          store.streamTokens = reply.split(/(\s+)/).filter(Boolean);
          return { accepted: true, result: { generationId } };
        }
        case "generation.pump": {
          // Advance one token of the active generation
          const generationId = store.activeGenerationId;
          if (!generationId) return { accepted: false };
          if (store.cancelRequested) {
            emit("generation.cancelled", { generationId });
            store.activeGenerationId = null;
            return { accepted: true, result: { done: true, cancelled: true } };
          }
          const next = store.streamTokens.shift();
          if (next === undefined) {
            const full = store.history.filter((m) => m.role === "user").slice(-1)[0]?.text ?? "";
            const text = `Echo: ${full}`;
            store.history.push({ id: `a_${generationId}`, role: "assistant", text });
            emit("generation.completed", {
              generationId,
              text,
            });
            store.activeGenerationId = null;
            return { accepted: true, result: { done: true } };
          }
          emit("generation.text.delta", { generationId, text: next });
          return { accepted: true, result: { done: false, token: next } };
        }
        case "generation.cancel": {
          store.cancelRequested = true;
          return { accepted: true };
        }
        case "history.snapshot":
          return {
            accepted: true,
            result: {
              messages: store.history.map((m) => ({
                id: m.id,
                role: m.role,
                text: m.text,
              })),
            },
          };
        case "runtime.health":
          return { accepted: true, result: { ok: true } };
        default:
          return { accepted: false, result: { error: `unknown command ${type}` } };
      }
    },
    drain(afterSeq, maxEvents) {
      const events = buffer.filter((e) => e.seq > afterSeq).slice(0, maxEvents);
      return { events, latestSeq: seq, overflow: false };
    },
    acknowledge(s) {
      acked = Math.max(acked, s);
      // drop acked
      while (buffer.length && buffer[0]!.seq <= acked) buffer.shift();
    },
    _emit: emit,
    _getStore: () => store,
  };

  return bridge;
}

/** Document-start script marker for mock backend (compat export). */
export const MOCK_BRIDGE_INSTALL_SCRIPT = `
/* __AIFROST_MOCK_BRIDGE_INSTALL__ */
/* AIFROST_PAGE_BRIDGE */
window.__AIFROST_BRIDGE__ = { version: "0.1.0-mock" };
`;

// Prefer PAGE_BRIDGE_INSTALL_SCRIPT from page-bridge/inject-source for real+mock shared path.
