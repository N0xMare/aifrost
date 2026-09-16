import type { SqliteDb } from "./db.js";
import type { Agent, Generation } from "../types/agent.js";
import type { SettingsSnapshot } from "../types/settings.js";
import type { NormalizedMessage } from "../types/messages.js";
import type { AgentEventEnvelope } from "../types/events.js";
import type { AgentId, GenerationId, MessageId, AccountId, EventId } from "../types/ids.js";

function j(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  return JSON.parse(raw) as T;
}

interface AgentRow {
  id: string;
  provider_id: string;
  account_id: string;
  lifecycle: string;
  activity: string;
  auth: string;
  conversation_json: string;
  current_generation_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
  deleted_at: string | null;
  desired_json: string | null;
  effective_json: string | null;
  settings_revision: number | null;
  observed_at: string | null;
  capabilities_revision: string | null;
}

interface MessageRow {
  id: string;
  agent_id: string;
  provider_message_id: string | null;
  role: string;
  content_json: string;
  created_at: string | null;
  metadata_json: string;
  seq: number;
}

interface GenerationRow {
  id: string;
  agent_id: string;
  protocol: string;
  state: string;
  input_message_ids_json: string;
  output_message_ids_json: string;
  started_at: string | null;
  completed_at: string | null;
  error_json: string | null;
}

interface EventRow {
  id: string;
  agent_id: string;
  generation_id: string | null;
  provider_id: string;
  type: string;
  seq: number;
  timestamp: string;
  payload_json: string;
}

export interface PersistedAgentBundle {
  agent: Agent;
  history: NormalizedMessage[];
  generations: Generation[];
}

/**
 * Durable control-plane repository backed by SQLite.
 */
export class AgentStore {
  constructor(private readonly db: SqliteDb) {}

  /** Upsert full agent record + settings snapshot. */
  saveAgent(agent: Agent): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agents (
            id, provider_id, account_id, lifecycle, activity, auth,
            conversation_json, current_generation_id, metadata_json,
            created_at, updated_at, revision, deleted_at
          ) VALUES (
            @id, @provider_id, @account_id, @lifecycle, @activity, @auth,
            @conversation_json, @current_generation_id, @metadata_json,
            @created_at, @updated_at, @revision, @deleted_at
          )
          ON CONFLICT(id) DO UPDATE SET
            provider_id = excluded.provider_id,
            account_id = excluded.account_id,
            lifecycle = excluded.lifecycle,
            activity = excluded.activity,
            auth = excluded.auth,
            conversation_json = excluded.conversation_json,
            current_generation_id = excluded.current_generation_id,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            revision = excluded.revision,
            deleted_at = excluded.deleted_at`,
        )
        .run({
          id: agent.id,
          provider_id: agent.providerId,
          account_id: agent.accountId,
          lifecycle: agent.lifecycle,
          activity: agent.activity,
          auth: agent.auth,
          conversation_json: j(agent.conversation),
          current_generation_id: agent.currentGenerationId,
          metadata_json: j(agent.metadata),
          created_at: agent.createdAt,
          updated_at: agent.updatedAt,
          revision: agent.revision,
          deleted_at: agent.lifecycle === "deleted" ? agent.updatedAt : null,
        });

      this.saveSettings(agent.id, agent.settings);
    });
    tx();
  }

  saveSettings(agentId: AgentId, settings: SettingsSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO agent_settings (
          agent_id, desired_json, effective_json, revision,
          observed_at, capabilities_revision
        ) VALUES (
          @agent_id, @desired_json, @effective_json, @revision,
          @observed_at, @capabilities_revision
        )
        ON CONFLICT(agent_id) DO UPDATE SET
          desired_json = excluded.desired_json,
          effective_json = excluded.effective_json,
          revision = excluded.revision,
          observed_at = excluded.observed_at,
          capabilities_revision = excluded.capabilities_revision`,
      )
      .run({
        agent_id: agentId,
        desired_json: j(settings.desired),
        effective_json: j(settings.effective),
        revision: settings.revision,
        observed_at: settings.observedAt,
        capabilities_revision: settings.capabilitiesRevision,
      });
  }

  getAgent(agentId: AgentId): Agent | null {
    const row = this.db
      .prepare(
        `SELECT a.*,
                s.desired_json, s.effective_json,
                s.revision AS settings_revision,
                s.observed_at, s.capabilities_revision
         FROM agents a
         LEFT JOIN agent_settings s ON s.agent_id = a.id
         WHERE a.id = ?`,
      )
      .get(agentId) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  /** List non-deleted agents by default. */
  listAgents(opts?: { includeDeleted?: boolean }): Agent[] {
    const sql = opts?.includeDeleted
      ? `SELECT a.*,
                s.desired_json, s.effective_json,
                s.revision AS settings_revision,
                s.observed_at, s.capabilities_revision
         FROM agents a
         LEFT JOIN agent_settings s ON s.agent_id = a.id
         ORDER BY a.created_at ASC`
      : `SELECT a.*,
                s.desired_json, s.effective_json,
                s.revision AS settings_revision,
                s.observed_at, s.capabilities_revision
         FROM agents a
         LEFT JOIN agent_settings s ON s.agent_id = a.id
         WHERE a.lifecycle != 'deleted' AND a.deleted_at IS NULL
         ORDER BY a.created_at ASC`;
    const rows = this.db.prepare(sql).all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  markDeleted(agentId: AgentId): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agents SET lifecycle = 'deleted', activity = 'idle',
         updated_at = ?, deleted_at = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run(now, now, agentId);
  }

  /**
   * Append a message. Seq is assigned as max(seq)+1 for the agent when omitted.
   * Idempotent on message id (INSERT OR REPLACE by id keeps same seq if re-saved).
   */
  appendMessage(message: NormalizedMessage, seq?: number): void {
    const existing = this.db.prepare(`SELECT seq FROM messages WHERE id = ?`).get(message.id) as
      { seq: number } | undefined;

    let nextSeq = seq;
    if (nextSeq === undefined) {
      if (existing) {
        nextSeq = existing.seq;
      } else {
        const max = this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE agent_id = ?`)
          .get(message.agentId) as { m: number };
        nextSeq = max.m + 1;
      }
    }

    this.db
      .prepare(
        `INSERT INTO messages (
          id, agent_id, provider_message_id, role, content_json,
          created_at, metadata_json, seq
        ) VALUES (
          @id, @agent_id, @provider_message_id, @role, @content_json,
          @created_at, @metadata_json, @seq
        )
        ON CONFLICT(id) DO UPDATE SET
          provider_message_id = excluded.provider_message_id,
          role = excluded.role,
          content_json = excluded.content_json,
          created_at = excluded.created_at,
          metadata_json = excluded.metadata_json,
          seq = excluded.seq`,
      )
      .run({
        id: message.id,
        agent_id: message.agentId,
        provider_message_id: message.providerMessageId,
        role: message.role,
        content_json: j(message.content),
        created_at: message.createdAt,
        metadata_json: j(message.metadata),
        seq: nextSeq,
      });
  }

  /** Replace agent history with the given ordered list (e.g. after a turn). */
  replaceMessages(agentId: AgentId, messages: NormalizedMessage[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE agent_id = ?`).run(agentId);
      let seq = 0;
      for (const m of messages) {
        seq += 1;
        this.db
          .prepare(
            `INSERT INTO messages (
              id, agent_id, provider_message_id, role, content_json,
              created_at, metadata_json, seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.id,
            m.agentId,
            m.providerMessageId,
            m.role,
            j(m.content),
            m.createdAt,
            j(m.metadata),
            seq,
          );
      }
    });
    tx();
  }

  listMessages(agentId: AgentId): NormalizedMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE agent_id = ? ORDER BY seq ASC`)
      .all(agentId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  saveGeneration(gen: Generation): void {
    this.db
      .prepare(
        `INSERT INTO generations (
          id, agent_id, protocol, state,
          input_message_ids_json, output_message_ids_json,
          started_at, completed_at, error_json
        ) VALUES (
          @id, @agent_id, @protocol, @state,
          @input_message_ids_json, @output_message_ids_json,
          @started_at, @completed_at, @error_json
        )
        ON CONFLICT(id) DO UPDATE SET
          protocol = excluded.protocol,
          state = excluded.state,
          input_message_ids_json = excluded.input_message_ids_json,
          output_message_ids_json = excluded.output_message_ids_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          error_json = excluded.error_json`,
      )
      .run({
        id: gen.id,
        agent_id: gen.agentId,
        protocol: gen.protocol,
        state: gen.state,
        input_message_ids_json: j(gen.inputMessageIds),
        output_message_ids_json: j(gen.outputMessageIds),
        started_at: gen.startedAt,
        completed_at: gen.completedAt,
        error_json: gen.error ? j(gen.error) : null,
      });
  }

  listGenerations(agentId: AgentId): Generation[] {
    const rows = this.db
      .prepare(`SELECT * FROM generations WHERE agent_id = ? ORDER BY started_at ASC`)
      .all(agentId) as GenerationRow[];
    return rows.map(rowToGeneration);
  }

  appendEvent(event: AgentEventEnvelope): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (
          id, agent_id, generation_id, provider_id, type, seq, timestamp, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.agentId,
        event.generationId ?? null,
        event.providerId,
        event.type,
        event.seq,
        event.timestamp,
        j(event.payload),
      );
  }

  listEvents(agentId: AgentId, afterSeq = 0, limit = 1000): AgentEventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE agent_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(agentId, afterSeq, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Max persisted event seq — reseeds the in-memory log on restart so new
   *  events don't collide with (agent_id, seq) rows already in the table. */
  maxEventSeq(agentId: AgentId): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE agent_id = ?`)
      .get(agentId) as { m: number };
    return row.m;
  }

  putIdempotency(
    key: string,
    responseJson: string,
    opts?: { agentId?: AgentId; expiresAt?: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (key, agent_id, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           response_json = excluded.response_json,
           agent_id = excluded.agent_id,
           expires_at = excluded.expires_at`,
      )
      .run(
        key,
        opts?.agentId ?? null,
        responseJson,
        new Date().toISOString(),
        opts?.expiresAt ?? null,
      );
  }

  getIdempotency(key: string): { responseJson: string; agentId: string | null } | null {
    const row = this.db
      .prepare(`SELECT response_json, agent_id, expires_at FROM idempotency_keys WHERE key = ?`)
      .get(key) as
      { response_json: string; agent_id: string | null; expires_at: string | null } | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < new Date().toISOString()) {
      this.db.prepare(`DELETE FROM idempotency_keys WHERE key = ?`).run(key);
      return null;
    }
    return { responseJson: row.response_json, agentId: row.agent_id };
  }

  /** Load agent + history for registry rehydrate. */
  loadBundle(agentId: AgentId): PersistedAgentBundle | null {
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle === "deleted") return null;
    return {
      agent,
      history: this.listMessages(agentId),
      generations: this.listGenerations(agentId),
    };
  }

  listBundles(): PersistedAgentBundle[] {
    return this.listAgents().map((agent) => ({
      agent,
      history: this.listMessages(agent.id),
      generations: this.listGenerations(agent.id),
    }));
  }

  /**
   * Persist after a completed/cancelled/failed turn: agent row, messages, generation.
   */
  persistTurn(agent: Agent, history: NormalizedMessage[], generation: Generation | null): void {
    const tx = this.db.transaction(() => {
      this.saveAgent(agent);
      this.replaceMessages(agent.id, history);
      if (generation) this.saveGeneration(generation);
    });
    tx();
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id as AgentId,
    providerId: row.provider_id,
    accountId: row.account_id as AccountId,
    lifecycle: row.lifecycle as Agent["lifecycle"],
    activity: row.activity as Agent["activity"],
    auth: row.auth as Agent["auth"],
    settings: {
      desired: parseJson(row.desired_json, {}),
      effective: parseJson(row.effective_json, {}),
      revision: row.settings_revision ?? 0,
      observedAt: row.observed_at,
      capabilitiesRevision: row.capabilities_revision,
    },
    conversation: parseJson(row.conversation_json, {
      providerConversationId: null,
      providerUrl: null,
      title: null,
      turnCount: 0,
      historyRevision: 0,
      fingerprint: null,
    }),
    currentGenerationId: (row.current_generation_id as GenerationId | null) ?? null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function rowToMessage(row: MessageRow): NormalizedMessage {
  return {
    id: row.id as MessageId,
    agentId: row.agent_id as AgentId,
    providerMessageId: row.provider_message_id,
    role: row.role as NormalizedMessage["role"],
    content: parseJson(row.content_json, []),
    createdAt: row.created_at,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function rowToGeneration(row: GenerationRow): Generation {
  return {
    id: row.id as GenerationId,
    agentId: row.agent_id as AgentId,
    protocol: row.protocol,
    state: row.state as Generation["state"],
    inputMessageIds: parseJson(row.input_message_ids_json, []),
    outputMessageIds: parseJson(row.output_message_ids_json, []),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: parseJson(row.error_json, null),
  };
}

function rowToEvent(row: EventRow): AgentEventEnvelope {
  return {
    id: row.id as EventId,
    seq: row.seq,
    type: row.type,
    timestamp: row.timestamp,
    agentId: row.agent_id as AgentId,
    generationId: (row.generation_id as GenerationId | undefined) ?? undefined,
    providerId: row.provider_id,
    payload: parseJson(row.payload_json, null),
  };
}
