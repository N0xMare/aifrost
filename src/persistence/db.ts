import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import { logger } from "../observability/logger.js";

export type SqliteDb = Database.Database;

export function resolveStateDir(stateDir?: string): string {
  return path.resolve(stateDir ?? process.env.AIFROST_STATE_DIR ?? "./state");
}

export function resolveDbPath(stateDir?: string): string {
  return path.join(resolveStateDir(stateDir), "aifrost.db");
}

/**
 * Open the control-plane SQLite DB at AIFROST_STATE_DIR/aifrost.db and migrate.
 */
export function openDb(stateDir?: string): SqliteDb {
  const dir = resolveStateDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "aifrost.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  logger.info({ dbPath, schemaVersion: SCHEMA_VERSION }, "opened control-plane db");
  return db;
}

/** In-memory DB for unit tests. */
export function openMemoryDb(): SqliteDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
    v: number;
  };
  let current = row.v;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString(),
      );
    });
    apply();
    current = m.version;
  }
}

export function closeDb(db: SqliteDb): void {
  db.close();
}
