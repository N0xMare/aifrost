/**
 * Chromium/Brave smoke — skipped when no binary is installed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { ChromiumBrowserBackend } from "../../../src/browser/chromium/backend.js";
import { PAGE_BRIDGE_INSTALL_SCRIPT } from "../../../src/page-bridge/inject-source.js";
import { PageBridgeHostClient } from "../../../src/page-bridge/host.js";
import { newAgentId } from "../../../src/types/ids.js";
import type { BrowserSession } from "../../../src/browser/backend.js";

const backend = new ChromiumBrowserBackend({
  requireBinary: false,
  headless: true,
  stateDir: join(process.cwd(), "state", "test-profiles"),
});
const hasBinary = backend.binaryAvailable();

describe.skipIf(!hasBinary)("Brave/Chromium CDP smoke", () => {
  let session: BrowserSession;

  beforeAll(async () => {
    await backend.start({ host: "127.0.0.1" });
    session = await backend.createRuntime({
      agentId: newAgentId(),
      accountId: "acct_chromium_smoke",
      startUrl: "data:text/html,<!doctype html><title>chromium-smoke</title><body>hello</body>",
      documentStartScripts: [PAGE_BRIDGE_INSTALL_SCRIPT],
    });
  }, 60_000);

  afterAll(async () => {
    await backend.shutdown();
  }, 30_000);

  it("launches Brave/Chrome and evaluates", async () => {
    expect(backend.getBrand()).toMatch(/brave|chrome|chromium/);
    const title = await session.evaluate("document.title");
    expect(title.exception).toBeUndefined();
    expect(title.value).toBe("chromium-smoke");
  });

  it("injects PageBridge at document-start", async () => {
    const ver = await session.evaluate(
      "window.__AIFROST_BRIDGE__ && window.__AIFROST_BRIDGE__.version",
    );
    expect(ver.value).toBeTruthy();
    const bridge = new PageBridgeHostClient(session);
    expect(await bridge.ready()).toBe(true);
  });

  it("runs fixture bridge generation pump", async () => {
    const bridge = new PageBridgeHostClient(session);
    await bridge.invoke({
      type: "generation.start",
      generationId: "gen_smoke",
      inputText: "hi",
    });
    let text = "";
    let last = 0;
    for (let i = 0; i < 40; i++) {
      await bridge.invoke({ type: "generation.pump" });
      const d = await bridge.drain(last, 50);
      for (const ev of d.events) {
        last = Math.max(last, ev.seq);
        if (ev.type === "generation.text.delta") {
          text += String((ev.payload as { text?: string }).text ?? "");
        }
        if (ev.type === "generation.completed") {
          expect(text).toBe("Echo: hi");
          return;
        }
      }
      await bridge.acknowledge(last);
    }
    throw new Error("generation did not complete");
  });
});
