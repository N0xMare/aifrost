/**
 * SQLite control-plane schema for Aifrost.
 * Minimal but useful: agents, settings, messages, generations, events, idempotency.
 */

export const SCHEMA_VERSION = 2;

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  activity TEXT NOT NULL,
  auth TEXT NOT NULL,
  conversation_json TEXT NOT NULL,
  current_generation_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_lifecycle ON agents(lifecycle);
CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents(provider_id);

CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  desired_json TEXT NOT NULL,
  effective_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  observed_at TEXT,
  capabilities_revision TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT,
  metadata_json TEXT NOT NULL,
  seq INTEGER NOT NULL,
  UNIQUE(agent_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_agent_seq ON messages(agent_id, seq);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  state TEXT NOT NULL,
  input_message_ids_json TEXT NOT NULL,
  output_message_ids_json TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_generations_agent ON generations(agent_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  generation_id TEXT,
  provider_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(agent_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events(agent_id, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  agent_id TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS account_rate_limits (
  account_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
