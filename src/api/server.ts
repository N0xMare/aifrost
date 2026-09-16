import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AifrostException, err, type AifrostError } from "../types/errors.js";
import { toPublicAgent } from "../types/agent.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import type { AgentActor } from "../core/agent-actor.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AccountRateLimitController } from "../core/account-rate-limit.js";
import { sanitizeOverride } from "../core/account-rate-limit.js";
import { enforceAuth, type AuthConfig } from "./auth.js";
import type { AgentId, GenerationId } from "../types/ids.js";
import type {
  CanonicalGenerationRequest,
  CanonicalGenerationResult,
  CreateAgentRequest,
  TurnInput,
} from "../types/generation.js";
import type { CanonicalGenerationEvent } from "../types/events.js";
import {
  aifrostErrorHttpStatus,
  encodeChatCompletion,
  encodeChatCompletionStream,
  encodeChatCompletionsError,
  encodeResponse,
  encodeResponseStream,
  encodeResponsesError,
  listModelsResponse,
  modelLabelForAgent,
  parseChatCompletionsRequest,
  parseResponsesRequest,
  turnInputFromRequest,
} from "../protocols/openai/index.js";
import { isValidAccountId } from "../types/ids.js";

/** Minimal idempotency persistence surface (satisfied by AgentStore). */
export interface IdempotencyStore {
  getIdempotency(key: string): { responseJson: string; agentId: string | null } | null;
  putIdempotency(
    key: string,
    responseJson: string,
    opts?: { agentId?: AgentId; expiresAt?: string | null },
  ): void;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  /**
   * Bearer shared secret. Prefer `auth` for full config.
   * When `auth` is omitted, mode is bearer with this token.
   */
  authToken?: string;
  /** Full auth config; overrides authToken when set. */
  auth?: AuthConfig;
  agents: AgentRegistry;
  providers: ProviderRegistry;
  rateLimiter?: AccountRateLimitController | null;
  /** Enables Idempotency-Key on POST /v1/agents and non-stream turns. */
  store?: IdempotencyStore | null;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    // SSE routes hijack the raw socket; force-close all connections on
    // app.close() so a connected stream can't wedge SIGINT/SIGTERM shutdown.
    forceCloseConnections: true,
  });

  const authConfig: AuthConfig =
    opts.auth ??
    ({
      mode: "bearer",
      token: opts.authToken ?? "",
    } satisfies AuthConfig);

  const auth = (req: FastifyRequest) => enforceAuth(req, authConfig);

  const idemStore = opts.store ?? null;
  // Single-flight: concurrent requests with the same key share one execution.
  const idemInflight = new Map<string, Promise<{ status: number; body: unknown }>>();
  const IDEM_TTL_MS = 24 * 3_600_000;

  const idempotencyKey = (req: FastifyRequest): string | null => {
    const raw = req.headers["idempotency-key"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string") return null;
    const key = v.trim();
    return key.length > 0 && key.length <= 255 ? key : null;
  };

  const withIdempotency = async (
    scope: string,
    req: FastifyRequest,
    execute: () => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown; replayed: boolean }> => {
    const rawKey = idempotencyKey(req);
    if (!idemStore || !rawKey) {
      return { ...(await execute()), replayed: false };
    }
    const key = `${scope}:${rawKey}`;
    const hit = idemStore.getIdempotency(key);
    if (hit) {
      try {
        const stored = JSON.parse(hit.responseJson) as {
          status: number;
          body: unknown;
        };
        return { status: stored.status, body: stored.body, replayed: true };
      } catch {
        /* corrupt row — fall through and re-execute */
      }
    }
    const pending = idemInflight.get(key);
    if (pending) {
      return { ...(await pending), replayed: true };
    }
    const run = execute()
      .then((r) => {
        try {
          idemStore.putIdempotency(key, JSON.stringify({ status: r.status, body: r.body }), {
            expiresAt: new Date(Date.now() + IDEM_TTL_MS).toISOString(),
          });
        } catch {
          /* persistence best-effort */
        }
        return r;
      })
      .finally(() => idemInflight.delete(key));
    idemInflight.set(key, run);
    return { ...(await run), replayed: false };
  };

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AifrostException) {
      return reply.status(error.httpStatus).send({
        error: error.error,
      });
    }
    // Fastify errors (malformed JSON, body too large, etc.) carry statusCode —
    // surface them as client errors instead of 500 internal_error.
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode >= 400 &&
      (error as { statusCode: number }).statusCode < 600
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(statusCode).send({
      error: {
        code:
          statusCode < 500
            ? String((error as { code?: string }).code ?? "invalid_request")
            : "internal_error",
        message,
        retryable: false,
      },
    });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => ({ ok: true }));

  app.get("/v1/rate-limit", async (req) => {
    auth(req);
    const rl = opts.rateLimiter;
    if (!rl) {
      return { enabled: false, mode: "off", note: "rate limiter not wired" };
    }
    const d = rl.globalDefaults();
    return {
      enabled: d.enabled,
      mode: d.mode,
      defaults: {
        max_inflight: d.maxInflight,
        min_submit_gap_ms: d.minSubmitGapMs,
        rolling_window_ms: d.rollingWindowMs,
        rolling_max_submits: d.rollingMaxSubmits,
        cooldown_ms: d.cooldownMs,
        max_cooldown_ms: d.maxCooldownMs,
        acquire_wait_ms: d.acquireWaitMs,
      },
    };
  });

  app.get<{ Params: { account_id: string } }>(
    "/v1/accounts/:account_id/rate-limit",
    async (req) => {
      auth(req);
      const rl = requireRateLimiter(opts.rateLimiter);
      return rl.snapshot(requireValidAccountId(req.params.account_id));
    },
  );

  app.patch<{ Params: { account_id: string } }>(
    "/v1/accounts/:account_id/rate-limit",
    async (req) => {
      auth(req);
      const rl = requireRateLimiter(opts.rateLimiter);
      const accountId = requireValidAccountId(req.params.account_id);
      const body = asBodyObject(req);
      if (body.reset === true || body.clear === true) {
        return rl.clearOverride(accountId);
      }
      return rl.setOverride(accountId, sanitizeOverride(body as never));
    },
  );

  app.get("/v1/providers", async (req) => {
    auth(req);
    return { object: "list", data: opts.providers.list() };
  });

  app.get<{ Params: { provider_id: string } }>("/v1/providers/:provider_id", async (req) => {
    auth(req);
    const adapter = opts.providers.get(req.params.provider_id);
    const def = opts.providers.list().find((p) => p.id === adapter.id);
    return def;
  });

  app.get<{ Params: { provider_id: string } }>(
    "/v1/providers/:provider_id/capabilities",
    async (req) => {
      auth(req);
      const adapter = opts.providers.get(req.params.provider_id);
      // Capabilities without a live page: static/scaffold inspection
      // Fixture returns full schema; chatgpt returns scaffold.
      // For fixture we need a page context — return static from inspect without ctx when possible.
      if (adapter.id === "fixture-web") {
        return adapter.inspectCapabilities({
          agentId: "agt_probe" as AgentId,
          providerId: adapter.id,
          accountId: "acct_default",
          session: null as never,
          bridge: {
            invoke: async () => ({}),
            drain: async () => ({ events: [], latestSeq: 0, overflow: false }),
            acknowledge: async () => undefined,
          },
        });
      }
      return adapter.inspectCapabilities({
        agentId: "agt_probe" as AgentId,
        providerId: adapter.id,
        accountId: "acct_default",
        session: null as never,
        bridge: {
          invoke: async () => ({}),
          drain: async () => ({ events: [], latestSeq: 0, overflow: false }),
          acknowledge: async () => undefined,
        },
      });
    },
  );

  app.post("/v1/agents", async (req, reply) => {
    auth(req);
    const body = asBodyObject(req);
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      throw err("invalid_request", "provider is required", 400);
    }
    if (!opts.providers.list().some((p) => p.id === body.provider)) {
      throw err("invalid_request", `Unknown provider: ${String(body.provider)}`, 400);
    }
    if (body.account_id !== undefined && body.account_id !== null) {
      requireValidAccountId(body.account_id);
    }
    if (
      body.conversation !== undefined &&
      (typeof body.conversation !== "object" || body.conversation === null)
    ) {
      throw err("invalid_request", "conversation must be an object", 400);
    }
    if (
      body.settings !== undefined &&
      (typeof body.settings !== "object" || body.settings === null || Array.isArray(body.settings))
    ) {
      throw err("invalid_request", "settings must be an object", 400);
    }
    const outcome = await withIdempotency("agents:create", req, async () => {
      const actor = await opts.agents.create(body as unknown as CreateAgentRequest);
      const snap = actor.snapshot();
      return {
        status: 201,
        body: toPublicAgent(
          snap.agent,
          {
            healthy: snap.runtime.healthy,
            pageReady: snap.runtime.pageReady,
            bridgeVersion: snap.runtime.bridgeVersion,
            providerBuildFingerprint: snap.runtime.providerBuildFingerprint,
          },
          snap.generation,
        ),
      };
    });
    return reply
      .status(outcome.status)
      .header("idempotent-replayed", outcome.replayed ? "true" : "false")
      .send(outcome.body);
  });

  app.get("/v1/agents", async (req) => {
    auth(req);
    const q = req.query as { provider?: string; lifecycle?: string };
    const data = opts.agents.list(q).map((a) => {
      const snap = a.snapshot();
      return toPublicAgent(
        snap.agent,
        {
          healthy: snap.runtime.healthy,
          pageReady: snap.runtime.pageReady,
          bridgeVersion: snap.runtime.bridgeVersion,
          providerBuildFingerprint: snap.runtime.providerBuildFingerprint,
        },
        snap.generation,
      );
    });
    return { object: "list", data };
  });

  app.get<{ Params: { agent_id: string } }>("/v1/agents/:agent_id", async (req) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const snap = actor.snapshot();
    return toPublicAgent(
      snap.agent,
      {
        healthy: snap.runtime.healthy,
        pageReady: snap.runtime.pageReady,
        bridgeVersion: snap.runtime.bridgeVersion,
        providerBuildFingerprint: snap.runtime.providerBuildFingerprint,
      },
      snap.generation,
    );
  });

  app.delete<{ Params: { agent_id: string } }>("/v1/agents/:agent_id", async (req, reply) => {
    auth(req);
    await opts.agents.delete(req.params.agent_id as AgentId);
    return reply.status(204).send();
  });

  app.patch<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/settings", async (req) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const body = asBodyObject(req);
    const ifMatch = req.headers["if-match"]
      ? Number(String(req.headers["if-match"]).replace(/^W\//i, "").replaceAll('"', ""))
      : undefined;
    const snap = await actor.applySettings(body, Number.isFinite(ifMatch) ? ifMatch : undefined);
    return {
      agent_id: snap.agent.id,
      desired: snap.agent.settings.desired,
      effective: snap.agent.settings.effective,
      revision: snap.agent.settings.revision,
      warnings: [],
    };
  });

  app.post<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/turns", async (req, reply) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const raw = asBodyObject(req);
    if (raw.input !== undefined && !Array.isArray(raw.input)) {
      throw err("invalid_request", "input must be an array", 400);
    }
    if (Array.isArray(raw.input) && raw.input.some((p) => !p || typeof p !== "object")) {
      throw err("invalid_request", "input items must be objects", 400);
    }
    if (raw.metadata !== undefined && (typeof raw.metadata !== "object" || raw.metadata === null)) {
      throw err("invalid_request", "metadata must be an object", 400);
    }
    const body = raw as unknown as TurnInput;
    const stream = body.stream !== false;
    const accept = String(req.headers.accept ?? "");
    const wantsSse = stream || accept.includes("text/event-stream");

    if (wantsSse && idempotencyKey(req)) {
      throw err(
        "invalid_request",
        "Idempotency-Key is not supported on streaming turns — set stream:false",
        400,
      );
    }

    if (wantsSse) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      let completed = false;
      const onDisconnect = () => {
        if (!completed) void actor.cancel();
      };
      req.socket.once("close", onDisconnect);

      try {
        for await (const ev of actor.startTurnStream(body)) {
          if (res.destroyed) break;
          writeSse(reply, ev);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!res.destroyed) {
          try {
            writeSseRaw(reply, "generation.failed", {
              error: { code: "internal_error", message },
            });
          } catch {
            /* client gone */
          }
        }
      } finally {
        completed = true;
        req.socket.off("close", onDisconnect);
        res.end();
      }
      return;
    }

    const outcome = await withIdempotency(`turns:${req.params.agent_id}`, req, async () => {
      const { events, snapshot } = await actor.startTurn(body);
      return {
        status: 200,
        body: {
          agent_id: snapshot.agent.id,
          generation: snapshot.generation,
          events,
          history_revision: snapshot.agent.conversation.historyRevision,
        },
      };
    });
    return reply
      .status(outcome.status)
      .header("idempotent-replayed", outcome.replayed ? "true" : "false")
      .send(outcome.body);
  });

  app.get<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/history", async (req) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const snap = actor.snapshot();
    return {
      agent_id: snap.agent.id,
      history_revision: snap.agent.conversation.historyRevision,
      fingerprint: snap.agent.conversation.fingerprint,
      data: actor.historyMessages(),
    };
  });

  app.get<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/events", async (req, reply) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const rawSeq = Number((req.query as { after_seq?: string }).after_seq ?? 0);
    const afterSeq = Number.isFinite(rawSeq) && rawSeq >= 0 ? rawSeq : 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const ac = new AbortController();
    req.socket.once("close", () => ac.abort());

    // events.stream() already replays the backlog — don't write it twice.
    try {
      for await (const ev of actor.events.stream(afterSeq, ac.signal)) {
        if (ac.signal.aborted || res.destroyed) break;
        res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } finally {
      res.end();
    }
  });

  app.post<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/cancel", async (req) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const body = asBodyObject(req);
    const snap = await actor.cancel(body.generation_id as GenerationId | undefined);
    return {
      agent_id: snap.agent.id,
      activity: snap.agent.activity,
      generation: snap.generation,
    };
  });

  app.post<{ Params: { agent_id: string } }>("/v1/agents/:agent_id/recover", async (req) => {
    auth(req);
    const actor = opts.agents.get(req.params.agent_id as AgentId);
    const snap = await actor.recover();
    return toPublicAgent(
      snap.agent,
      {
        healthy: snap.runtime.healthy,
        pageReady: snap.runtime.pageReady,
        bridgeVersion: snap.runtime.bridgeVersion,
        providerBuildFingerprint: snap.runtime.providerBuildFingerprint,
      },
      snap.generation,
    );
  });

  // ─── OpenAI compatibility gateways ────────────────────────────────

  const chatCompletionsHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
    agentId: AgentId,
  ) => {
    auth(req);
    const actor = opts.agents.get(agentId);
    const snap = actor.snapshot();
    const history = actor.historyMessages();

    let request: CanonicalGenerationRequest;
    try {
      request = parseChatCompletionsRequest(req.body, snap.agent, { history });
    } catch (e) {
      return sendProtocolError(reply, e, encodeChatCompletionsError);
    }

    const model = modelLabelForAgent(snap.agent, (req.body as { model?: unknown } | null)?.model);
    const turn = turnInputFromRequest(request);

    if (request.stream) {
      return streamProtocol(req, reply, actor, turn, request.generationId, (events) =>
        encodeChatCompletionStream(events, {
          model,
          generationId: request.generationId,
        }),
      );
    }

    try {
      const { events } = await actor.startTurn(turn, request.generationId);
      const result = resultFromEvents(request.generationId, events);
      const encoded = encodeChatCompletion(result, { model });
      return reply.status(encoded.status).headers(encoded.headers).send(encoded.body);
    } catch (e) {
      return sendProtocolError(reply, e, encodeChatCompletionsError);
    }
  };

  const responsesHandler = async (req: FastifyRequest, reply: FastifyReply, agentId: AgentId) => {
    auth(req);
    const actor = opts.agents.get(agentId);
    const snap = actor.snapshot();
    const history = actor.historyMessages();

    let request: CanonicalGenerationRequest;
    try {
      request = parseResponsesRequest(req.body, snap.agent, { history });
    } catch (e) {
      return sendProtocolError(reply, e, encodeResponsesError);
    }

    const model = modelLabelForAgent(snap.agent, (req.body as { model?: unknown } | null)?.model);
    const turn = turnInputFromRequest(request);

    if (request.stream) {
      return streamProtocol(req, reply, actor, turn, request.generationId, (events) =>
        encodeResponseStream(events, {
          model,
          generationId: request.generationId,
        }),
      );
    }

    try {
      const { events } = await actor.startTurn(turn, request.generationId);
      const result = resultFromEvents(request.generationId, events);
      const encoded = encodeResponse(result, { model });
      return reply.status(encoded.status).headers(encoded.headers).send(encoded.body);
    } catch (e) {
      return sendProtocolError(reply, e, encodeResponsesError);
    }
  };

  const modelsHandler = async (req: FastifyRequest, reply: FastifyReply, agentId: AgentId) => {
    auth(req);
    const actor = opts.agents.get(agentId);
    const encoded = listModelsResponse(actor.snapshot().agent);
    return reply.status(encoded.status).headers(encoded.headers).send(encoded.body);
  };

  // Agent-scoped mounts (SDK base URL: .../compat/openai/agents/{id}/v1)
  app.post<{ Params: { agent_id: string } }>(
    "/compat/openai/agents/:agent_id/v1/chat/completions",
    async (req, reply) => chatCompletionsHandler(req, reply, req.params.agent_id as AgentId),
  );
  app.post<{ Params: { agent_id: string } }>(
    "/compat/openai/agents/:agent_id/v1/responses",
    async (req, reply) => responsesHandler(req, reply, req.params.agent_id as AgentId),
  );
  app.get<{ Params: { agent_id: string } }>(
    "/compat/openai/agents/:agent_id/v1/models",
    async (req, reply) => modelsHandler(req, reply, req.params.agent_id as AgentId),
  );

  // Global aliases — require Aifrost-Agent-Id header (auth first: 401 > 400)
  app.post("/v1/chat/completions", async (req, reply) => {
    auth(req);
    const agentId = requireAgentIdHeader(req);
    return chatCompletionsHandler(req, reply, agentId);
  });
  app.post("/v1/responses", async (req, reply) => {
    auth(req);
    const agentId = requireAgentIdHeader(req);
    return responsesHandler(req, reply, agentId);
  });

  return app;
}

function requireAgentIdHeader(req: FastifyRequest): AgentId {
  const raw =
    req.headers["aifrost-agent-id"] ?? req.headers["Aifrost-Agent-Id" as keyof typeof req.headers];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string" || !value.startsWith("agt_")) {
    throw new AifrostException(
      {
        code: "invalid_request",
        message: "Aifrost-Agent-Id header is required for global OpenAI aliases",
        retryable: false,
      },
      400,
    );
  }
  return value as AgentId;
}

function resultFromEvents(
  generationId: GenerationId,
  events: CanonicalGenerationEvent[],
): CanonicalGenerationResult {
  for (const ev of events) {
    if (ev.type === "generation.completed") {
      return {
        generationId: ev.generationId,
        messages: ev.messages,
        usage: ev.usage,
        toolIntents: ev.toolIntents,
      };
    }
    if (ev.type === "generation.cancelled") {
      return { generationId: ev.generationId, messages: [], cancelled: true };
    }
    if (ev.type === "generation.failed") {
      throw new AifrostException(ev.error, aifrostErrorHttpStatus(ev.error));
    }
  }
  return { generationId, messages: [] };
}

function sendProtocolError(
  reply: FastifyReply,
  e: unknown,
  encode: (error: AifrostError) => {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  },
) {
  if (e instanceof AifrostException) {
    const encoded = encode(e.error);
    return reply.status(encoded.status).headers(encoded.headers).send(encoded.body);
  }
  const message = e instanceof Error ? e.message : String(e);
  const encoded = encode({
    code: "internal_error",
    message,
    retryable: false,
  });
  return reply.status(encoded.status).headers(encoded.headers).send(encoded.body);
}

async function streamProtocol(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: AgentActor,
  turn: TurnInput,
  generationId: GenerationId,
  encode: (events: AsyncIterable<CanonicalGenerationEvent>) => AsyncIterable<Uint8Array>,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  // Client disconnect → cancel the generation instead of letting it run
  // to completion with nobody listening.
  let completed = false;
  const onDisconnect = () => {
    if (!completed) void actor.cancel(generationId);
  };
  req.socket.once("close", onDisconnect);

  const safeWrite = (chunk: string | Uint8Array): void => {
    if (res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      /* client gone */
    }
  };

  try {
    const events = actor.startTurnStream(turn, generationId);
    for await (const chunk of encode(events)) {
      if (res.destroyed) break;
      safeWrite(chunk);
    }
  } catch (e) {
    if (e instanceof AifrostException) {
      safeWrite(
        `data: ${JSON.stringify({
          error: {
            message: e.error.message,
            type: "server_error",
            code: e.error.code,
            aifrost: e.error,
          },
        })}\n\n`,
      );
    } else {
      const message = e instanceof Error ? e.message : String(e);
      safeWrite(
        `data: ${JSON.stringify({
          error: { message, type: "server_error", code: "internal_error" },
        })}\n\n`,
      );
    }
  } finally {
    completed = true;
    req.socket.off("close", onDisconnect);
    res.end();
  }
}

function writeSse(reply: FastifyReply, ev: CanonicalGenerationEvent): void {
  const type = ev.type;
  writeSseRaw(reply, type, ev);
}

function writeSseRaw(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function requireRateLimiter(
  rl: AccountRateLimitController | null | undefined,
): AccountRateLimitController {
  if (!rl) {
    throw err("rate_limit_unavailable", "Rate limiter is not enabled on this server process", 503);
  }
  return rl;
}

function asBodyObject(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    throw err("invalid_request", "Request body must be a JSON object", 400);
  }
  return b as Record<string, unknown>;
}

function requireValidAccountId(raw: unknown): string {
  if (!isValidAccountId(raw)) {
    throw err("invalid_request", "account_id must match ^[A-Za-z0-9_-]{1,64}$", 400);
  }
  return raw;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = await buildServer(opts);
  const host = opts.host ?? process.env.AIFROST_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.AIFROST_PORT ?? 8787);
  await app.listen({ host, port });
  return app;
}
