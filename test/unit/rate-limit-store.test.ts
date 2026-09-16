import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../../src/persistence/db.js";
import { SqliteAccountRateLimitStore } from "../../src/persistence/rate-limit-store.js";

describe("SqliteAccountRateLimitStore", () => {
  it("round-trips, upserts, lists, deletes, tolerates corrupt rows", () => {
    const db = openMemoryDb();
    const store = new SqliteAccountRateLimitStore(db);

    expect(store.get("acct_x")).toBeNull();

    store.put("acct_x", { mode: "agentic", max_inflight: 2 });
    expect(store.get("acct_x")).toEqual({ mode: "agentic", max_inflight: 2 });

    // upsert replaces the row
    store.put("acct_x", { mode: "off" });
    expect(store.get("acct_x")).toEqual({ mode: "off" });

    store.put("acct_y", { min_submit_gap_ms: 500 });
    expect(
      store
        .list()
        .map((r) => r.account_id)
        .sort(),
    ).toEqual(["acct_x", "acct_y"]);

    store.delete("acct_x");
    expect(store.get("acct_x")).toBeNull();
    expect(store.list().map((r) => r.account_id)).toEqual(["acct_y"]);

    // Corrupt policy_json: get() → null, list() → {} (never throws)
    db.prepare(
      "INSERT INTO account_rate_limits (account_id, policy_json, updated_at) VALUES (?, ?, ?)",
    ).run("acct_bad", "{not json", new Date().toISOString());
    expect(store.get("acct_bad")).toBeNull();
    expect(store.list().find((r) => r.account_id === "acct_bad")?.policy).toEqual({});
  });
});
