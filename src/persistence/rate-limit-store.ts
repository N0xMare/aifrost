/**
 * Durable per-account rate-limit overrides.
 */

import type { SqliteDb } from "./db.js";
import type { AccountRateLimitOverride } from "../core/account-rate-limit.js";
import { sanitizeOverride } from "../core/account-rate-limit.js";

export interface AccountRateLimitStore {
  get(accountId: string): AccountRateLimitOverride | null;
  put(accountId: string, policy: AccountRateLimitOverride): void;
  delete(accountId: string): void;
  list(): Array<{ account_id: string; policy: AccountRateLimitOverride }>;
}

export class SqliteAccountRateLimitStore implements AccountRateLimitStore {
  constructor(private readonly db: SqliteDb) {}

  get(accountId: string): AccountRateLimitOverride | null {
    const row = this.db
      .prepare("SELECT policy_json FROM account_rate_limits WHERE account_id = ?")
      .get(accountId) as { policy_json: string } | undefined;
    if (!row) return null;
    try {
      return sanitizeOverride(JSON.parse(row.policy_json) as AccountRateLimitOverride);
    } catch {
      return null;
    }
  }

  put(accountId: string, policy: AccountRateLimitOverride): void {
    this.db
      .prepare(
        `INSERT INTO account_rate_limits (account_id, policy_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           updated_at = excluded.updated_at`,
      )
      .run(accountId, JSON.stringify(sanitizeOverride(policy)), new Date().toISOString());
  }

  delete(accountId: string): void {
    this.db.prepare("DELETE FROM account_rate_limits WHERE account_id = ?").run(accountId);
  }

  list(): Array<{ account_id: string; policy: AccountRateLimitOverride }> {
    const rows = this.db
      .prepare("SELECT account_id, policy_json FROM account_rate_limits")
      .all() as Array<{ account_id: string; policy_json: string }>;
    return rows.map((r) => {
      try {
        return {
          account_id: r.account_id,
          policy: sanitizeOverride(JSON.parse(r.policy_json) as AccountRateLimitOverride),
        };
      } catch {
        return { account_id: r.account_id, policy: {} };
      }
    });
  }
}
