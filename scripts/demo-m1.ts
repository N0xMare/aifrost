/**
 * Fixture demo: create → configure → turn → history → cancel → recover
 * Default: mock browser (no Chromium required).
 */
import { createDefaultProviderRegistry } from "../src/providers/registry.js";
import { AgentRegistry } from "../src/core/agent-registry.js";
import { extractPlainText } from "../src/types/messages.js";
import { createBrowserBackend } from "../src/browser/factory.js";

async function main(): Promise<void> {
  const { backend: browser, kind } = await createBrowserBackend({
    kind: (process.env.AIFROST_BROWSER as "mock" | "chromium" | "auto") ?? "mock",
  });
  console.log("browser backend:", kind);
  const providers = createDefaultProviderRegistry();
  const agents = new AgentRegistry(browser, providers);

  console.log("== create agent ==");
  const actor = await agents.create({
    provider: "fixture-web",
    account_id: "acct_demo",
    conversation: { mode: "new" },
    settings: { model_or_mode: "fixture-fast" },
    metadata: { purpose: "m1-demo" },
  });
  let snap = actor.snapshot();
  const agentId = snap.agent.id;
  console.log({
    id: agentId,
    lifecycle: snap.agent.lifecycle,
    settings: snap.agent.settings,
    conversation: snap.agent.conversation.providerConversationId,
  });

  console.log("\n== configure settings ==");
  snap = await actor.applySettings({
    model_or_mode: "fixture-expert",
    reasoning: { effort: "high" },
  });
  console.log({
    desired: snap.agent.settings.desired,
    effective: snap.agent.settings.effective,
    revision: snap.agent.settings.revision,
  });

  console.log("\n== send turn (stream) ==");
  let text = "";
  for await (const ev of actor.startTurnStream({
    input: [{ type: "input_text", text: "Hello Aifrost" }],
    stream: true,
  })) {
    if (ev.type === "output_text.delta") {
      text += ev.delta;
      process.stdout.write(ev.delta);
    } else {
      console.log("\n event:", ev.type);
    }
  }
  console.log("\n assembled:", text);

  console.log("\n== history ==");
  for (const m of actor.historyMessages()) {
    console.log(`  [${m.role}] ${extractPlainText(m)}`);
  }

  console.log("\n== cancel mid-generation ==");
  const turnPromise = (async () => {
    const events = [];
    for await (const ev of actor.startTurnStream({
      input: [{ type: "input_text", text: "This should be cancelled mid-stream" }],
      stream: true,
    })) {
      events.push(ev.type);
      if (ev.type === "output_text.delta") {
        void actor.cancel();
      }
    }
    return events;
  })();
  console.log(" events:", await turnPromise);
  console.log(" activity after:", actor.snapshot().agent.activity);

  console.log("\n== recover ==");
  const beforeRuntime = actor.snapshot().runtime.runtimeId;
  snap = await actor.recover();
  console.log({
    id: snap.agent.id,
    sameId: snap.agent.id === agentId,
    lifecycle: snap.agent.lifecycle,
    runtimeChanged: snap.runtime.runtimeId !== beforeRuntime,
  });

  await agents.delete(agentId);
  await browser.shutdown();
  console.log("\nDemo complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
