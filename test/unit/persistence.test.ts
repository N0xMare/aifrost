import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, openMemoryDb, closeDb, resolveDbPath } from "../../src/persistence/db.js";
import { AgentStore } from "../../src/persistence/repositories.js";
import { MockBrowserBackend } from "../../src/browser/mock/backend.js";
import { createDefaultProviderRegistry } from "../../src/providers/registry.js";
import { AgentRegistry } from "../../src/core/agent-registry.js";
import { extractPlainText } from "../../src/types/messages.js";
import type { AgentId } from "../../src/types/ids.js";
import type { NormalizedMessage } from "../../src/types/messages.js";
import type { Agent } from "../../src/types/agent.js";

describe("SQLite schema + AgentStore", () => {
  it("migrates and round-trips agent, settings, messages, generation, events", () => {
    const db = openMemoryDb();
    const store = new AgentStore(db);

    const agent: Agent = {
      id: "agt_test_persist_01" as AgentId,
      providerId: "fixture-web",
      accountId: "acct_default" as Agent["accountId"],
      lifecycle: "ready",
      activity: "idle",
      auth: "authenticated",
      settings: {
        desired: { model_or_mode: "fixture-expert" },
        effective: { model_or_mode: "fixture-expert" },
        revision: 2,
        observedAt: "2026-01-01T00:00:00.000Z",
        capabilitiesRevision: "caps-1",
      },
      conversation: {
        providerConversationId: "conv_1",
        providerUrl: null,
        title: "t",
        turnCount: 1,
        historyRevision: 2,
        fingerprint: null,
      },
      currentGenerationId: null,
      metadata: { purpose: "unit" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      revision: 3,
    };

    store.saveAgent(agent);
    const loaded = store.getAgent(agent.id);
    expect(loaded).toMatchObject({
      id: agent.id,
      providerId: "fixture-web",
      lifecycle: "ready",
      settings: {
        desired: { model_or_mode: "fixture-expert" },
        revision: 2,
        capabilitiesRevision: "caps-1",
      },
      conversation: { providerConversationId: "conv_1", turnCount: 1 },
      metadata: { purpose: "unit" },
    });

    const msg: NormalizedMessage = {
      id: "msg_user_1" as NormalizedMessage["id"],
      agentId: agent.id,
      providerMessageId: null,
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-01-01T00:00:02.000Z",
      metadata: {},
    };
    store.appendMessage(msg);
    expect(store.listMessages(agent.id)).toHaveLength(1);
    expect(extractPlainText(store.listMessages(agent.id)[0]!)).toBe("hello");

    store.saveGeneration({
      id: "gen_1" as import("../../src/types/ids.js").GenerationId,
      agentId: agent.id,
      protocol: "native",
      state: "completed",
      inputMessageIds: [msg.id],
      outputMessageIds: [],
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
      error: null,
    });
    expect(store.listGenerations(agent.id)).toHaveLength(1);
    expect(store.listGenerations(agent.id)[0]!.state).toBe("completed");

    store.appendEvent({
      id: "evt_1" as never,
      seq: 1,
      type: "agent.lifecycle",
      timestamp: "2026-01-01T00:00:00.000Z",
      agentId: agent.id,
      providerId: "fixture-web",
      payload: { lifecycle: "ready" },
    });
    expect(store.listEvents(agent.id)).toHaveLength(1);

    store.putIdempotency("idem-1", JSON.stringify({ ok: true }), {
      agentId: agent.id,
    });
    expect(store.getIdempotency("idem-1")?.responseJson).toBe(JSON.stringify({ ok: true }));

    store.markDeleted(agent.id);
    expect(store.listAgents()).toHaveLength(0);
    expect(store.listAgents({ includeDeleted: true })[0]!.lifecycle).toBe("deleted");

    closeDb(db);
  });

  it("opens DB under AIFROST_STATE_DIR / stateDir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifrost-db-"));
    const db = openDb(dir);
    expect(fs.existsSync(path.join(dir, "aifrost.db"))).toBe(true);
    expect(resolveDbPath(dir)).toBe(path.join(path.resolve(dir), "aifrost.db"));
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("AgentRegistry persistence wiring", () => {
  let browser: MockBrowserBackend;
  let db: ReturnType<typeof openMemoryDb>;
  let store: AgentStore;

  beforeEach(async () => {
    browser = new MockBrowserBackend();
    await browser.start({});
    db = openMemoryDb();
    store = new AgentStore(db);
  });

  afterEach(async () => {
    await browser.shutdown();
    closeDb(db);
  });

  it("persists create, settings, turn, and reloads without auto-starting browser", async () => {
    const providers = createDefaultProviderRegistry();
    const agents = new AgentRegistry(browser, providers, store);

    const actor = await agents.create({
      provider: "fixture-web",
      settings: { model_or_mode: "fixture-default" },
      metadata: { purpose: "persist-test" },
    });
    const id = actor.agentId;

    await actor.applySettings({ model_or_mode: "fixture-expert" });

    for await (const _ of actor.startTurnStream({
      input: [{ type: "input_text", text: "persist me" }],
      stream: true,
    })) {
      // drain
    }

    const hist = actor.historyMessages();
    expect(hist).toHaveLength(2);

    // DB has agent + messages
    const persisted = store.getAgent(id);
    expect(persisted).not.toBeNull();
    expect(persisted!.settings.effective.model_or_mode).toBe("fixture-expert");
    expect(store.listMessages(id)).toHaveLength(2);
    expect(store.listGenerations(id).length).toBeGreaterThanOrEqual(1);
    expect(store.listEvents(id).length).toBeGreaterThan(0);

    // Simulate server restart: new registry, same store, no browser auto-start
    const browser2 = new MockBrowserBackend();
    await browser2.start({});
    const agents2 = new AgentRegistry(browser2, providers, store);
    const loaded = agents2.loadFromStore();
    expect(loaded).toBe(1);

    const rehydrated = agents2.get(id);
    const snap = rehydrated.snapshot();
    expect(snap.agent.id).toBe(id);
    expect(snap.agent.lifecycle).toBe("ready");
    expect(snap.agent.settings.effective.model_or_mode).toBe("fixture-expert");
    expect(snap.history).toHaveLength(2);
    expect(snap.runtime.runtimeId).toBeNull();
    expect(snap.runtime.pageReady).toBe(false);
    expect(extractPlainText(snap.history[1]!)).toBe("Echo: persist me");

    // First turn after rehydrate attaches runtime lazily
    const { events } = await rehydrated.startTurn({
      input: [{ type: "input_text", text: "after reload" }],
    });
    expect(events.some((e) => e.type === "generation.completed")).toBe(true);
    expect(rehydrated.snapshot().runtime.runtimeId).not.toBeNull();
    expect(rehydrated.historyMessages()).toHaveLength(4);

    await agents2.delete(id);
    expect(store.listAgents()).toHaveLength(0);
    expect(store.getAgent(id)?.lifecycle).toBe("deleted");

    await browser2.shutdown();
  });

  it("works without store (existing mock tests pattern)", async () => {
    const agents = new AgentRegistry(browser, createDefaultProviderRegistry(), null);
    const actor = await agents.create({ provider: "fixture-web" });
    expect(actor.snapshot().agent.lifecycle).toBe("ready");
    await agents.delete(actor.agentId);
  });
});
