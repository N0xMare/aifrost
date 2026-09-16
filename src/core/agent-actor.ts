import type { BrowserBackend, BrowserSession } from "../browser/backend.js";
import { PAGE_BRIDGE_INSTALL_SCRIPT } from "../page-bridge/inject-source.js";
import { PageBridgeHostClient } from "../page-bridge/host.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderPageContext, ProviderWebUIAdapter } from "../providers/contract.js";
import type { Agent, Generation } from "../types/agent.js";
import type { AgentEventEnvelope, CanonicalGenerationEvent } from "../types/events.js";
import type { CreateAgentRequest, TurnInput } from "../types/generation.js";
import type { NormalizedMessage } from "../types/messages.js";
import { textContent } from "../types/messages.js";
import {
  newAgentId,
  newGenerationId,
  newMessageId,
  type AccountId,
  type AgentId,
  type GenerationId,
  type RuntimeId,
} from "../types/ids.js";
import { err, AifrostException, type AifrostError } from "../types/errors.js";
import { AgentEventLog } from "./event-log.js";
import type { AgentStore } from "../persistence/repositories.js";
import {
  classifyRateLimitText,
  type AccountRateLimitController,
  type RateLimitLease,
} from "./account-rate-limit.js";

export interface ActorSnapshot {
  agent: Agent;
  generation: Generation | null;
  history: NormalizedMessage[];
  runtime: {
    healthy: boolean;
    pageReady: boolean;
    bridgeVersion: string | null;
    providerBuildFingerprint: string | null;
    runtimeId: RuntimeId | null;
  };
}

/**
 * Serialized owner of one agent. All browser mutations go through the queue.
 */
export class AgentActor {
  readonly agentId: AgentId;
  private agent: Agent;
  private generation: Generation | null = null;
  private history: NormalizedMessage[] = [];
  private session: BrowserSession | null = null;
  private runtimeId: RuntimeId | null = null;
  private adapter: ProviderWebUIAdapter | null = null;
  private queue: Promise<void> = Promise.resolve();
  readonly events = new AgentEventLog();
  private providerBuildFingerprint: string | null = null;
  private readonly store: AgentStore | null;
  private readonly rateLimiter: AccountRateLimitController | null;

  constructor(
    private readonly browser: BrowserBackend,
    private readonly providers: ProviderRegistry,
    seed?: Partial<Agent> & { providerId: string; accountId: AccountId },
    store?: AgentStore | null,
    rateLimiter?: AccountRateLimitController | null,
  ) {
    this.store = store ?? null;
    this.rateLimiter = rateLimiter ?? null;
    const now = new Date().toISOString();
    this.agentId = seed?.id ?? newAgentId();
    this.agent = {
      id: this.agentId,
      providerId: seed?.providerId ?? "fixture-web",
      accountId: seed?.accountId ?? ("acct_default" as AccountId),
      lifecycle: "creating",
      activity: "idle",
      auth: "unknown",
      settings: {
        desired: {},
        effective: {},
        revision: 0,
        observedAt: null,
        capabilitiesRevision: null,
      },
      conversation: {
        providerConversationId: null,
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
      revision: 0,
    };
  }

  /**
   * Rebuild an actor from durable state without attaching a browser runtime.
   * Lifecycle is normalized to "ready" (browser detached until first turn/recover).
   */
  static fromPersisted(
    browser: BrowserBackend,
    providers: ProviderRegistry,
    agent: Agent,
    history: NormalizedMessage[] = [],
    store?: AgentStore | null,
    rateLimiter?: AccountRateLimitController | null,
  ): AgentActor {
    const actor = new AgentActor(
      browser,
      providers,
      {
        id: agent.id,
        providerId: agent.providerId,
        accountId: agent.accountId,
      },
      store,
      rateLimiter,
    );
    actor.agent = {
      ...structuredClone(agent),
      // Survive restart without auto-starting browser; attach lazily.
      lifecycle:
        agent.lifecycle === "deleted"
          ? "deleted"
          : agent.lifecycle === "failed"
            ? "degraded"
            : "ready",
      activity: "idle",
      currentGenerationId: null,
    };
    actor.history = structuredClone(history);
    actor.generation = null;
    actor.adapter = null;
    actor.session = null;
    actor.runtimeId = null;
    return actor;
  }

  snapshot(): ActorSnapshot {
    const info = this.session?.info();
    return {
      agent: structuredClone(this.agent),
      generation: this.generation ? structuredClone(this.generation) : null,
      history: structuredClone(this.history),
      runtime: {
        healthy: info?.health === "healthy",
        // pageReady only when a live session is attached (rehydrated agents are detached)
        pageReady: Boolean(this.session) && this.agent.lifecycle === "ready",
        bridgeVersion: info?.bridgeVersion ?? null,
        providerBuildFingerprint: this.providerBuildFingerprint,
        runtimeId: this.runtimeId,
      },
    };
  }

  /** Enqueue a command; mutations are serialized. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const done = this.queue.then(fn, fn);
    this.queue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  async create(request: CreateAgentRequest): Promise<ActorSnapshot> {
    return this.run(() => this.createImpl(request));
  }

  async applySettings(
    desired: Record<string, unknown>,
    ifMatchRevision?: number,
  ): Promise<ActorSnapshot> {
    return this.run(() => this.applySettingsImpl(desired, ifMatchRevision));
  }

  async startTurn(
    turn: TurnInput,
    generationId: GenerationId = newGenerationId(),
  ): Promise<{ snapshot: ActorSnapshot; events: CanonicalGenerationEvent[] }> {
    return this.run(() => this.startTurnImpl(turn, generationId));
  }

  /**
   * Streaming turn: yields canonical events while holding the actor lock for the full generation.
   * The queue position is claimed at CALL time (not first next()) so ordering
   * is preserved even if iteration is deferred.
   */
  startTurnStream(
    turn: TurnInput,
    generationId: GenerationId = newGenerationId(),
  ): AsyncIterable<CanonicalGenerationEvent> {
    // Serialize by chaining on the queue with a manual gate
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.queue;
    this.queue = prev.then(() => gate);
    const gen = this.generateStreamImpl.bind(this);
    return {
      async *[Symbol.asyncIterator]() {
        await prev;
        try {
          yield* gen(turn, generationId);
        } finally {
          release();
        }
      },
    };
  }

  /**
   * Cancel must not wait behind the generation lock — signal immediately so the
   * active generate loop / provider stream can observe cancellation.
   */
  async cancel(generationId?: GenerationId): Promise<ActorSnapshot> {
    const target = generationId ?? this.agent.currentGenerationId;
    if (!target || target !== this.agent.currentGenerationId) {
      return this.snapshot();
    }
    if (this.agent.activity !== "generating" && this.agent.activity !== "cancelling") {
      return this.snapshot();
    }
    if (this.generation && this.generation.id === target) {
      this.generation.state = "cancelling";
    }
    this.touch({ activity: "cancelling" });
    // Provider cancel is best-effort concurrent with the active generate drain.
    if (this.adapter && this.session) {
      try {
        await this.adapter.cancel(this.ctx(), target);
      } catch {
        // generate loop will still surface terminal state
      }
    }
    return this.snapshot();
  }

  async recover(): Promise<ActorSnapshot> {
    return this.run(() => this.recoverImpl());
  }

  async delete(): Promise<void> {
    return this.run(() => this.deleteImpl());
  }

  async inspect(): Promise<ActorSnapshot> {
    return this.snapshot();
  }

  historyMessages(): NormalizedMessage[] {
    return structuredClone(this.history);
  }

  // ─── implementations ─────────────────────────────────────────────

  private async createImpl(request: CreateAgentRequest): Promise<ActorSnapshot> {
    this.agent.providerId = request.provider;
    if (request.account_id) {
      this.agent.accountId = request.account_id as AccountId;
    }
    if (request.metadata) {
      this.agent.metadata = { ...request.metadata };
    }
    if (request.settings) {
      this.agent.settings.desired = { ...request.settings };
    }

    this.adapter = this.providers.get(request.provider);
    this.touch({ lifecycle: "creating" });

    const startUrl = providerStartUrl(request.provider);
    // Only inject full fixture bridge on fixture provider; live providers get a minimal host hook
    const scripts =
      request.provider === "fixture-web" ? [PAGE_BRIDGE_INSTALL_SCRIPT] : [MINIMAL_BRIDGE_SCRIPT];

    const session = await this.browser.createRuntime({
      agentId: this.agentId,
      accountId: this.agent.accountId,
      startUrl,
      documentStartScripts: scripts,
    });
    this.session = session;
    this.runtimeId = session.info().runtimeId;

    const ctx = this.ctx();
    try {
      try {
        await this.adapter.awaitReady(ctx);
      } catch {
        // continue — readState will report auth/challenge
      }
      const detection = await this.adapter.detect(ctx);
      this.providerBuildFingerprint = detection.buildFingerprint ?? null;

      if (request.conversation?.mode === "open" && request.conversation.provider_conversation_id) {
        await this.adapter.openConversation(ctx, {
          providerConversationId: request.conversation.provider_conversation_id,
        });
        this.agent.conversation.providerConversationId =
          request.conversation.provider_conversation_id;
      } else if (request.provider === "fixture-web") {
        const conv = await this.adapter.createConversation(ctx);
        this.agent.conversation.providerConversationId = conv.providerConversationId ?? null;
        this.agent.conversation.providerUrl = conv.providerUrl ?? null;
      } else {
        // Live providers: createConversation may navigate; best-effort
        try {
          const conv = await this.adapter.createConversation(ctx);
          this.agent.conversation.providerConversationId = conv.providerConversationId ?? null;
          this.agent.conversation.providerUrl = conv.providerUrl ?? null;
        } catch {
          /* leave null until first successful turn */
        }
      }

      if (request.settings && Object.keys(request.settings).length) {
        const applied = await this.adapter.applySettings(ctx, request.settings);
        this.agent.settings.desired = applied.desired;
        this.agent.settings.effective = applied.effective;
        this.agent.settings.revision += 1;
        this.agent.settings.observedAt = new Date().toISOString();
      } else {
        const state = await this.adapter.readState(ctx);
        this.agent.settings.effective = state.settings;
        this.agent.settings.desired = { ...state.settings };
        this.agent.settings.observedAt = new Date().toISOString();
        this.agent.auth = state.auth;
      }

      const caps = await this.adapter.inspectCapabilities(ctx);
      this.agent.settings.capabilitiesRevision = caps.revision;
      const state = await this.adapter.readState(ctx);
      this.agent.auth = state.auth;
      if (state.conversation.providerConversationId) {
        this.agent.conversation.providerConversationId ??=
          state.conversation.providerConversationId;
        this.agent.conversation.providerUrl ??= state.conversation.providerUrl ?? null;
        this.agent.conversation.title ??= state.conversation.title ?? null;
      }
    } catch (e) {
      // A failed create must not leak the browser tab.
      await this.browser.destroyRuntime(this.runtimeId).catch(() => undefined);
      this.session = null;
      this.runtimeId = null;
      this.touch({ lifecycle: "failed", activity: "idle" });
      this.persistAgent();
      throw e;
    }
    // ready even if login_required — client can inspect and run login doctor
    this.touch({
      lifecycle: this.agent.auth === "login_required" ? "degraded" : "ready",
      activity: "idle",
    });
    this.emit("agent.lifecycle", {
      lifecycle: this.agent.lifecycle,
      auth: this.agent.auth,
    });
    this.persistAgent();
    return this.snapshot();
  }

  private async applySettingsImpl(
    desired: Record<string, unknown>,
    ifMatchRevision?: number,
  ): Promise<ActorSnapshot> {
    this.assertReady();
    await this.ensureRuntime();
    if (this.agent.activity !== "idle") {
      throw err("agent_busy", "Cannot change settings while generating", 409, {
        agentId: this.agentId,
      });
    }
    if (ifMatchRevision !== undefined && ifMatchRevision !== this.agent.settings.revision) {
      throw err(
        "settings_revision_conflict",
        `Settings revision mismatch: expected ${ifMatchRevision}, got ${this.agent.settings.revision}`,
        409,
        { agentId: this.agentId },
      );
    }

    const merged = { ...this.agent.settings.desired, ...desired };
    const applied = await this.adapter!.applySettings(this.ctx(), merged);
    this.agent.settings.desired = applied.desired;
    this.agent.settings.effective = applied.effective;
    this.agent.settings.revision += 1;
    this.agent.settings.observedAt = new Date().toISOString();
    this.touch({});
    this.emit("agent.settings", {
      desired: this.agent.settings.desired,
      effective: this.agent.settings.effective,
      revision: this.agent.settings.revision,
      warnings: applied.warnings,
      mismatches: applied.mismatches,
    });
    this.persistAgent();
    return this.snapshot();
  }

  private async startTurnImpl(
    turn: TurnInput,
    generationId: GenerationId,
  ): Promise<{ snapshot: ActorSnapshot; events: CanonicalGenerationEvent[] }> {
    const events: CanonicalGenerationEvent[] = [];
    for await (const ev of this.generateStreamImpl(turn, generationId)) {
      events.push(ev);
    }
    return { snapshot: this.snapshot(), events };
  }

  private async *generateStreamImpl(
    turn: TurnInput,
    generationId: GenerationId,
  ): AsyncGenerator<CanonicalGenerationEvent> {
    this.assertReady();
    await this.ensureRuntime();
    if (this.agent.activity === "generating" || this.agent.activity === "cancelling") {
      throw err("agent_busy", "Agent already has an active generation", 409, {
        agentId: this.agentId,
      });
    }

    // Validate BEFORE acquiring the rate-limit lease — a bad request must not
    // leak an inflight slot (a leaked lease wedges the account for minutes).
    if (!Array.isArray(turn.input)) {
      throw err("invalid_request", "turn.input must be an array", 400, {
        agentId: this.agentId,
      });
    }
    // Inference MUST NOT silently mutate persistent settings
    if (turn.metadata && "settings" in turn.metadata) {
      throw err(
        "agent_configuration_conflict",
        "Turn metadata must not include settings mutations; use PATCH /settings",
        409,
        { agentId: this.agentId },
      );
    }

    const userText = turn.input
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("");

    const userMessage: NormalizedMessage = {
      id: newMessageId(),
      agentId: this.agentId,
      providerMessageId: null,
      role: "user",
      content: [textContent(userText)],
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    // Account-level ChatGPT pace (chatgpt-web only). Fail before history mutation.
    let lease: RateLimitLease | null = null;
    let rateLimitClass: ReturnType<typeof classifyRateLimitText> = null;
    if (this.rateLimiter) {
      lease = await this.rateLimiter.acquire({
        accountId: this.agent.accountId,
        providerId: this.agent.providerId,
        agentId: this.agentId,
      });
    }

    try {
      this.history.push(userMessage);
      this.agent.conversation.turnCount += 1;
      this.agent.conversation.historyRevision += 1;

      this.generation = {
        id: generationId,
        agentId: this.agentId,
        protocol: turn.protocol ?? "native",
        state: "starting",
        inputMessageIds: [userMessage.id],
        outputMessageIds: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      };
      this.agent.currentGenerationId = generationId;
      this.touch({ activity: "generating" });

      const toolsFromTurn = turn.tools ?? [];
      const toolsFromMeta = Array.isArray(
        (turn.metadata as { client_tools?: unknown } | undefined)?.client_tools,
      )
        ? ((turn.metadata as { client_tools: typeof toolsFromTurn }).client_tools ?? [])
        : [];
      const clientTools = toolsFromTurn.length > 0 ? toolsFromTurn : toolsFromMeta;

      const request = {
        agentId: this.agentId,
        generationId,
        sourceProtocol: turn.protocol ?? "native",
        messages: [...this.history],
        newTurnMessages: [userMessage],
        stream: turn.stream ?? true,
        requestedSettings: {},
        tools: clientTools,
        responseFormat: null,
        metadata: turn.metadata ?? {},
      };

      for await (const ev of this.adapter!.generate(this.ctx(), request)) {
        if (this.generation) {
          if (ev.type === "generation.started") this.generation.state = "streaming";
          if (ev.type === "generation.completed") {
            this.generation.state = "completed";
            this.generation.completedAt = new Date().toISOString();
            const toolOnly =
              Array.isArray(ev.toolIntents) &&
              ev.toolIntents.length > 0 &&
              ev.messages.length === 0;
            if (toolOnly) {
              // tool_calls façade: nothing was committed to the WebUI transcript.
              // Drop the provisional user row so a Pi retry / new turn is not
              // stuck on 409 against a half-open tool-call history.
              const last = this.history[this.history.length - 1];
              if (last?.id === userMessage.id) {
                this.history.pop();
                this.agent.conversation.turnCount = Math.max(
                  0,
                  this.agent.conversation.turnCount - 1,
                );
              }
            } else {
              for (const m of ev.messages) {
                this.history.push(m);
                this.generation.outputMessageIds.push(m.id);
              }
            }
            this.agent.conversation.historyRevision += 1;
            // The first send creates the conversation server-side — the URL
            // only gains /c/<id> during generation. Pick it up now so recovery
            // and follow-up turns reopen the same conversation.
            if (!this.agent.conversation.providerConversationId) {
              try {
                const st = await this.adapter!.readState(this.ctx());
                if (st.conversation.providerConversationId) {
                  this.agent.conversation.providerConversationId =
                    st.conversation.providerConversationId;
                  this.agent.conversation.providerUrl =
                    st.conversation.providerUrl ?? this.agent.conversation.providerUrl;
                  this.agent.conversation.title ??= st.conversation.title ?? null;
                }
              } catch {
                /* best-effort — readState failure must not fail the turn */
              }
            }
          }
          if (ev.type === "generation.cancelled") {
            this.generation.state = "cancelled";
            this.generation.completedAt = new Date().toISOString();
            // Drop provisional user so a client retry is not stuck with empty suffix.
            this.dropProvisionalUserIf(userMessage.id);
          }
          if (ev.type === "generation.failed") {
            this.generation.state = "failed";
            this.generation.completedAt = new Date().toISOString();
            this.generation.error = {
              code: ev.error.code,
              message: ev.error.message,
            };
            this.dropProvisionalUserIf(userMessage.id);
            rateLimitClass =
              ev.error.code === "rate_limited"
                ? (classifyRateLimitText(ev.error.message) ?? "A")
                : classifyRateLimitText(ev.error.message);
          }
        }

        this.emit(ev.type, ev, generationId);
        yield ev;

        if (
          ev.type === "generation.completed" ||
          ev.type === "generation.cancelled" ||
          ev.type === "generation.failed"
        ) {
          break;
        }
      }
    } catch (e) {
      // Unified failure path: every adapter throw (rate_limited,
      // tool_scaffold_incomplete, transport, ...) becomes a generation.failed
      // event carrying the ORIGINAL error code — the HTTP layer maps it via
      // aifrostErrorHttpStatus (429/503), SSE forwards the code verbatim.
      const error: AifrostError =
        e instanceof AifrostException
          ? e.error
          : {
              code: "provider_output_invalid",
              message: e instanceof Error ? e.message : String(e),
              retryable: true,
              agentId: this.agentId,
              generationId,
            };
      rateLimitClass =
        (e instanceof AifrostException && e.error.code === "rate_limited"
          ? (classifyRateLimitText(e.error.message) ?? "A")
          : classifyRateLimitText(error.message)) ?? rateLimitClass;
      if (this.generation) {
        this.generation.state = "failed";
        this.generation.completedAt = new Date().toISOString();
        this.generation.error = { code: error.code, message: error.message };
      }
      this.dropProvisionalUserIf(userMessage.id);
      const fail: CanonicalGenerationEvent = {
        type: "generation.failed",
        generationId,
        error,
      };
      this.emit(fail.type, fail, generationId);
      yield fail;
    } finally {
      lease?.release(rateLimitClass ? { rateLimited: true, klass: rateLimitClass } : undefined);
      this.agent.currentGenerationId = null;
      this.touch({ activity: "idle" });
      this.persistTurnComplete();
    }
  }

  private async recoverImpl(): Promise<ActorSnapshot> {
    this.touch({ lifecycle: "recovering" });
    this.emit("agent.recovery", { phase: "start" });

    // Destroy and recreate runtime; preserve agent ID and local history/settings
    if (this.runtimeId) {
      try {
        await this.browser.destroyRuntime(this.runtimeId);
      } finally {
        this.runtimeId = null;
        this.session = null;
      }
    }

    try {
      await this.attachRuntime({ reopenConversation: true, reapplySettings: true });
    } catch (e) {
      // Never strand the agent in "recovering" — mark degraded and rethrow.
      this.touch({ lifecycle: "degraded", activity: "idle" });
      this.emit("agent.recovery", { phase: "failed", agentId: this.agentId });
      this.persistAgent();
      throw e;
    }

    this.generation = null;
    this.agent.currentGenerationId = null;
    // auth was set by attachRuntime's readState — don't overwrite it.
    this.touch({
      lifecycle: this.agent.auth === "login_required" ? "degraded" : "ready",
      activity: "idle",
    });
    this.emit("agent.recovery", { phase: "complete", agentId: this.agentId });
    this.persistAgent();
    return this.snapshot();
  }

  private async deleteImpl(): Promise<void> {
    this.touch({ lifecycle: "deleting" });
    try {
      if (this.runtimeId) {
        await this.browser.destroyRuntime(this.runtimeId);
      }
    } finally {
      // Even if runtime teardown fails, the agent must not stay "deleting"
      // forever — mark deleted and let the registry drop it.
      this.runtimeId = null;
      this.session = null;
      this.touch({ lifecycle: "deleted" });
      this.emit("agent.lifecycle", { lifecycle: "deleted" });
      if (this.store) {
        try {
          this.store.markDeleted(this.agentId);
        } catch {
          // best-effort; still remove from memory
        }
      }
    }
  }

  /**
   * Attach a browser runtime if this actor was rehydrated without one.
   * Used on first turn / settings after server restart.
   */
  private async ensureRuntime(): Promise<void> {
    if (this.session && this.adapter) return;
    await this.attachRuntime({ reopenConversation: true, reapplySettings: true });
  }

  private async attachRuntime(opts: {
    reopenConversation: boolean;
    reapplySettings: boolean;
  }): Promise<void> {
    this.adapter = this.providers.get(this.agent.providerId);
    const startUrl = providerStartUrl(this.agent.providerId);
    const scripts =
      this.agent.providerId === "fixture-web"
        ? [PAGE_BRIDGE_INSTALL_SCRIPT]
        : [MINIMAL_BRIDGE_SCRIPT];

    const session = await this.browser.createRuntime({
      agentId: this.agentId,
      accountId: this.agent.accountId,
      startUrl,
      documentStartScripts: scripts,
    });
    this.session = session;
    this.runtimeId = session.info().runtimeId;

    const ctx = this.ctx();
    try {
      try {
        await this.adapter.awaitReady(ctx);
      } catch {
        // continue — readState / generate will surface auth issues
      }
      const detection = await this.adapter.detect(ctx);
      this.providerBuildFingerprint = detection.buildFingerprint ?? null;
    } catch (e) {
      // A failed attach must not leave a half-attached session behind —
      // ensureRuntime would otherwise never retry a fresh attach.
      await this.browser.destroyRuntime(this.runtimeId).catch(() => undefined);
      this.session = null;
      this.runtimeId = null;
      throw e;
    }

    if (opts.reopenConversation) {
      if (this.agent.conversation.providerConversationId) {
        try {
          await this.adapter.openConversation(ctx, {
            providerConversationId: this.agent.conversation.providerConversationId,
          });
        } catch {
          /* leave existing conversation ids */
        }
      } else if (this.agent.providerId === "fixture-web") {
        const conv = await this.adapter.createConversation(ctx);
        this.agent.conversation.providerConversationId = conv.providerConversationId ?? null;
        this.agent.conversation.providerUrl =
          conv.providerUrl ?? this.agent.conversation.providerUrl;
      } else {
        try {
          const conv = await this.adapter.createConversation(ctx);
          this.agent.conversation.providerConversationId = conv.providerConversationId ?? null;
          this.agent.conversation.providerUrl =
            conv.providerUrl ?? this.agent.conversation.providerUrl;
        } catch {
          /* leave null */
        }
      }
    }

    if (opts.reapplySettings && Object.keys(this.agent.settings.desired).length) {
      try {
        const applied = await this.adapter.applySettings(ctx, this.agent.settings.desired);
        this.agent.settings.effective = applied.effective;
        this.agent.settings.observedAt = new Date().toISOString();
      } catch {
        /* keep desired; effective may be stale until next success */
      }
    }

    try {
      const state = await this.adapter.readState(ctx);
      this.agent.auth = state.auth;
    } catch {
      this.agent.auth = "unknown";
    }
  }

  private ctx(): ProviderPageContext {
    if (!this.session || !this.adapter) {
      throw err("agent_unavailable", "No browser session", 503, {
        agentId: this.agentId,
      });
    }
    return {
      agentId: this.agentId,
      providerId: this.agent.providerId,
      session: this.session,
      accountId: this.agent.accountId,
      bridge: new PageBridgeHostClient(this.session),
    };
  }

  private assertReady(): void {
    if (this.agent.lifecycle === "deleted") {
      throw err("agent_not_found", "Agent deleted", 404, { agentId: this.agentId });
    }
    if (this.agent.lifecycle !== "ready" && this.agent.lifecycle !== "degraded") {
      throw err("agent_unavailable", `Agent lifecycle is ${this.agent.lifecycle}`, 503, {
        agentId: this.agentId,
      });
    }
    // Session may be absent for rehydrated agents; callers use ensureRuntime().
  }

  /**
   * If generation failed/cancelled before an assistant commit, remove the
   * provisional user row so Pi can retry without empty-suffix 400.
   * (tool_calls-only success already pops this row.)
   */
  private dropProvisionalUserIf(userMessageId: string): void {
    const last = this.history[this.history.length - 1];
    if (last?.id === userMessageId && last.role === "user") {
      this.history.pop();
      this.agent.conversation.turnCount = Math.max(0, this.agent.conversation.turnCount - 1);
      this.agent.conversation.historyRevision += 1;
    }
  }

  private touch(patch: Partial<Pick<Agent, "lifecycle" | "activity" | "auth">>): void {
    Object.assign(this.agent, patch);
    this.agent.updatedAt = new Date().toISOString();
    this.agent.revision += 1;
  }

  private emit(type: string, payload: unknown, generationId?: GenerationId): AgentEventEnvelope {
    const ev = this.events.append(this.agentId, this.agent.providerId, type, payload, generationId);
    if (this.store) {
      // High-frequency deltas are not persisted — one blocking SQLite write
      // per streamed token would slow every agent and bloat the events table.
      const persistent =
        type !== "output_text.delta" &&
        type !== "reasoning.summary.delta" &&
        type !== "tool_call.delta";
      if (persistent) {
        try {
          this.store.appendEvent(ev);
        } catch {
          // event durability is best-effort relative to in-memory log
        }
      }
    }
    return ev;
  }

  private persistAgent(): void {
    if (!this.store) return;
    try {
      this.store.saveAgent(this.agent);
    } catch {
      // do not fail the control-plane mutation on persistence errors
    }
  }

  private persistTurnComplete(): void {
    if (!this.store) return;
    try {
      this.store.persistTurn(this.agent, this.history, this.generation);
    } catch {
      // best-effort
    }
  }
}

/**
 * Fixture uses a data: document so document-start scripts run without a network.
 * Live providers use their real HTTPS origins.
 */
function providerStartUrl(providerId: string): string {
  switch (providerId) {
    case "fixture-web":
      return "data:text/html,<!doctype html><title>aifrost-fixture</title><body data-aifrost-fixture=1>fixture</body>";
    case "chatgpt-web":
      return "https://chatgpt.com/";
    default:
      return "about:blank";
  }
}

/** Minimal document-start marker for live providers (no fixture store). */
const MINIMAL_BRIDGE_SCRIPT = `
/* AIFROST_PAGE_BRIDGE_MINIMAL */
(function(){
  if (window.__AIFROST_BRIDGE__) return;
  var seq = 0, buffer = [];
  function emit(type, payload) {
    seq += 1;
    buffer.push({ seq: seq, type: type, payload: payload, timestamp: new Date().toISOString() });
  }
  window.__AIFROST_BRIDGE__ = {
    version: "0.2.0-live",
    state: function(){ return { ready: true, providerId: null, seq: seq }; },
    invoke: function(){ return { accepted: false, result: { error: "use_provider_adapter" } }; },
    drain: function(after, max){
      var out = [];
      for (var i = 0; i < buffer.length && out.length < (max||100); i++) {
        if (buffer[i].seq > after) out.push(buffer[i]);
      }
      return { events: out, latestSeq: seq, overflow: false };
    },
    acknowledge: function(s){
      while (buffer.length && buffer[0].seq <= s) buffer.shift();
    }
  };
  emit("bridge.ready", { bridgeVersion: "0.2.0-live" });
})();
`;
