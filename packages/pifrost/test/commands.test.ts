import { describe, expect, it, vi } from "vitest";
import {
  handleAifrostCommand,
  parseAifrostArgs,
  parseCreateArgs,
  type CommandDeps,
  type CommandUi,
} from "../extensions/commands.js";
import type { AifrostAgent } from "../extensions/client.js";
import { AifrostClientError } from "../extensions/client.js";
import { resolveConfig } from "../extensions/config.js";

function ui(): CommandUi & { messages: Array<{ msg: string; level?: string }> } {
  const messages: Array<{ msg: string; level?: string }> = [];
  return {
    messages,
    notify(message, level) {
      messages.push({ msg: message, level });
    },
  };
}

function agent(partial: Partial<AifrostAgent> & Pick<AifrostAgent, "id">): AifrostAgent {
  return {
    provider: "chatgpt-web",
    account_id: "acct_default",
    lifecycle: "ready",
    ...partial,
  };
}

function baseDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    config: resolveConfig({
      AIFROST_URL: "http://127.0.0.1:8787",
      AIFROST_AUTH_TOKEN: "tok",
    }),
    refresh: async () => ({ agents: [], error: null }),
    healthCheck: async () => ({ ok: true }),
    listAgents: async () => [],
    createAgent: async () => agent({ id: "agt_new" }),
    ...overrides,
  };
}

describe("parseAifrostArgs", () => {
  it("defaults to help", () => {
    expect(parseAifrostArgs("")).toEqual({ sub: "help", rest: [] });
    expect(parseAifrostArgs("   ")).toEqual({ sub: "help", rest: [] });
  });

  it("splits sub and rest", () => {
    expect(parseAifrostArgs("create acct_main")).toEqual({
      sub: "create",
      rest: ["acct_main"],
    });
    expect(parseAifrostArgs("STATUS")).toEqual({ sub: "status", rest: [] });
  });
});

describe("parseCreateArgs", () => {
  it("defaults fixture-web", () => {
    expect(parseCreateArgs([])).toEqual({
      accountId: "acct_default",
      provider: "fixture-web",
    });
  });

  it("account only", () => {
    expect(parseCreateArgs(["acct_pi"])).toEqual({
      accountId: "acct_pi",
      provider: "fixture-web",
    });
  });

  it("account + provider", () => {
    expect(parseCreateArgs(["acct_main", "chatgpt-web"])).toEqual({
      accountId: "acct_main",
      provider: "chatgpt-web",
    });
  });

  it("provider only", () => {
    expect(parseCreateArgs(["fixture-web"])).toEqual({
      accountId: "acct_default",
      provider: "fixture-web",
    });
  });
});

describe("handleAifrostCommand", () => {
  it("help prints usage", async () => {
    const u = ui();
    await handleAifrostCommand("help", u, baseDeps());
    expect(u.messages[0]?.msg).toMatch(/\/aifrost status/);
    expect(u.messages[0]?.msg).toMatch(/ratelimit/);
    expect(u.messages[0]?.level).toBe("info");
  });

  it("ratelimit status uses injected client", async () => {
    const u = ui();
    await handleAifrostCommand(
      "ratelimit status acct_main",
      u,
      baseDeps({
        getAccountRateLimit: async (_url, _tok, account) => ({
          account_id: account,
          enabled: true,
          mode: "agentic",
          policy: {
            min_submit_gap_ms: 10000,
            max_inflight: 1,
            rolling_max_submits: 24,
            rolling_window_ms: 900000,
          },
          state: { inflight: 0, submitsInWindow: 2, cooldown_until: null },
        }),
      }),
    );
    expect(u.messages[0]?.msg).toMatch(/acct_main/);
    expect(u.messages[0]?.msg).toMatch(/mode=agentic/);
  });

  it("ratelimit set patches kv pairs", async () => {
    const u = ui();
    let patched: Record<string, unknown> | null = null;
    await handleAifrostCommand(
      "ratelimit set acct_main mode=interactive min_submit_gap_ms=8000",
      u,
      baseDeps({
        patchAccountRateLimit: async (_u, _t, account, body) => {
          patched = { account, ...body };
          return {
            account_id: account,
            enabled: true,
            mode: String(body.mode ?? "interactive"),
            policy: { min_submit_gap_ms: 8000, max_inflight: 1 },
            state: {},
          };
        },
      }),
    );
    expect(patched).toMatchObject({
      account: "acct_main",
      mode: "interactive",
      min_submit_gap_ms: 8000,
    });
    expect(u.messages[0]?.msg).toMatch(/interactive/);
  });

  it("unknown subcommand warns", async () => {
    const u = ui();
    await handleAifrostCommand("nope", u, baseDeps());
    expect(u.messages[0]?.level).toBe("warning");
    expect(u.messages[0]?.msg).toMatch(/Unknown/);
  });

  it("status reports health and count", async () => {
    const u = ui();
    await handleAifrostCommand(
      "status",
      u,
      baseDeps({
        listAgents: async () => [
          agent({ id: "agt_1" }),
          agent({ id: "agt_2", lifecycle: "deleted" }),
        ],
      }),
    );
    expect(u.messages[0]?.msg).toMatch(/Aifrost ok/);
    expect(u.messages[0]?.msg).toMatch(/1 agent/);
  });

  it("status notes auth=none when no bearer", async () => {
    const u = ui();
    await handleAifrostCommand(
      "status",
      u,
      baseDeps({
        config: resolveConfig({ AIFROST_URL: "http://x", AIFROST_AUTH: "none" }),
        listAgents: async () => [],
      }),
    );
    expect(u.messages[0]?.msg).toMatch(/auth=none/);
  });

  it("refresh success reports model count", async () => {
    const u = ui();
    await handleAifrostCommand(
      "refresh",
      u,
      baseDeps({
        refresh: async () => ({
          agents: [agent({ id: "agt_1" })],
          error: null,
        }),
      }),
    );
    expect(u.messages[0]?.level).toBe("info");
    expect(u.messages[0]?.msg).toMatch(/1 model/);
  });

  it("refresh failure reports error not success", async () => {
    const u = ui();
    await handleAifrostCommand(
      "refresh",
      u,
      baseDeps({
        refresh: async () => ({
          agents: [],
          error: "Failed to list agents: HTTP 401",
        }),
      }),
    );
    expect(u.messages[0]?.level).toBe("error");
    expect(u.messages[0]?.msg).toMatch(/refresh failed/);
    expect(u.messages[0]?.msg).not.toMatch(/refreshed —/);
  });

  it("create defaults to fixture-web and acct_default", async () => {
    const u = ui();
    const createAgent = vi.fn(async (_b: string, _t: string, body: unknown) => {
      expect(body).toEqual({
        provider: "fixture-web",
        account_id: "acct_default",
      });
      return agent({
        id: "agt_created",
        account_id: "acct_default",
        provider: "fixture-web",
      });
    });
    const refresh = vi.fn(async () => ({
      agents: [agent({ id: "agt_created" })],
      error: null,
    }));
    await handleAifrostCommand("create", u, baseDeps({ createAgent, refresh }));
    expect(createAgent).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(u.messages[0]?.msg).toMatch(/agt_created/);
  });

  it("create uses account_id and optional provider", async () => {
    const u = ui();
    const createAgent = vi.fn(
      async (
        _b: string,
        _t: string,
        body: {
          account_id?: string;
          provider?: string;
        },
      ) => {
        expect(body.account_id).toBe("acct_main");
        expect(body.provider).toBe("chatgpt-web");
        return agent({ id: "agt_x", account_id: "acct_main" });
      },
    );
    await handleAifrostCommand(
      "create acct_main chatgpt-web",
      u,
      baseDeps({
        createAgent,
        refresh: async () => ({ agents: [], error: null }),
      }),
    );
    expect(createAgent).toHaveBeenCalledOnce();
  });

  it("create surfaces create errors", async () => {
    const u = ui();
    await handleAifrostCommand(
      "create",
      u,
      baseDeps({
        createAgent: async () => {
          throw new AifrostClientError("Failed to create agent: HTTP 401", 401);
        },
      }),
    );
    expect(u.messages[0]?.level).toBe("error");
    expect(u.messages[0]?.msg).toMatch(/401/);
  });

  it("clear deletes all non-deleted agents", async () => {
    const u = ui();
    const deleted: string[] = [];
    await handleAifrostCommand(
      "clear",
      u,
      baseDeps({
        listAgents: async () => [
          agent({ id: "agt_a", provider: "chatgpt-web" }),
          agent({ id: "agt_b", provider: "fixture-web" }),
          agent({ id: "agt_gone", lifecycle: "deleted" }),
        ],
        deleteAgent: async (_u, _t, id) => {
          deleted.push(id);
        },
        refresh: async () => ({ agents: [], error: null }),
      }),
    );
    expect(deleted.sort()).toEqual(["agt_a", "agt_b"]);
    expect(u.messages[0]?.msg).toMatch(/Cleared 2/);
  });

  it("agents lists rows", async () => {
    const u = ui();
    await handleAifrostCommand(
      "agents",
      u,
      baseDeps({
        listAgents: async () => [
          agent({
            id: "agt_1",
            provider: "fixture-web",
            account_id: "acct_pi",
            lifecycle: "ready",
          }),
        ],
      }),
    );
    expect(u.messages[0]?.msg).toMatch(/agt_1/);
    expect(u.messages[0]?.msg).toMatch(/fixture-web/);
  });
});
