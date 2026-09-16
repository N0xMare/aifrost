import type { BrowserRuntimeInfo, BrowserSession, EvaluateResult } from "../backend.js";
import type { AgentId, RuntimeId } from "../../types/ids.js";
import { RawCdpClient, type CdpClient } from "../cdp/client.js";
import type { ChromiumProcessHandle } from "./process.js";

export interface ChromiumSessionOptions {
  runtimeId: RuntimeId;
  agentId: AgentId;
  process: ChromiumProcessHandle;
  startUrl: string;
  documentStartScripts?: string[];
}

export class ChromiumBrowserSession implements BrowserSession {
  readonly runtimeId: RuntimeId;
  readonly agentId: AgentId;
  private readonly process: ChromiumProcessHandle;
  private readonly cdp: CdpClient;
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private pageGeneration = 0;
  private health: BrowserRuntimeInfo["health"] = "starting";
  private dead = false;
  private bridgeVersion: string | null = null;
  private startUrl: string;
  private scripts: string[];

  constructor(opts: ChromiumSessionOptions) {
    this.runtimeId = opts.runtimeId;
    this.agentId = opts.agentId;
    this.process = opts.process;
    this.startUrl = opts.startUrl;
    this.scripts = [...(opts.documentStartScripts ?? [])];
    this.cdp = new RawCdpClient();
  }

  async bootstrap(): Promise<void> {
    await this.cdp.connect(this.process.wsUrl);

    // Always create a dedicated page for this agent runtime so multiple agents
    // on the same account profile don't fight over one about:blank tab.
    // Do NOT fall back to grabbing an arbitrary existing page — that could
    // hijack another agent's tab.
    const created = await this.cdp.send<{ targetId: string }>({
      method: "Target.createTarget",
      params: { url: "about:blank" },
    });
    this.targetId = created.targetId;

    const attached = await this.cdp.send<{ sessionId: string }>({
      method: "Target.attachToTarget",
      params: { targetId: this.targetId, flatten: true },
    });
    this.sessionId = attached.sessionId;

    this.watchForDeath();

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable").catch(() => undefined);
    await this.send("Inspector.enable").catch(() => undefined);

    for (const source of this.scripts) {
      await this.addScriptOnNewDocument(source);
    }

    if (this.startUrl && this.startUrl !== "about:blank") {
      await this.navigate(this.startUrl);
    } else {
      this.pageGeneration = 1;
    }

    const bridge = await this.evaluate(
      `window.__AIFROST_BRIDGE__ && window.__AIFROST_BRIDGE__.version`,
    );
    if (bridge.value != null && !bridge.exception) {
      this.bridgeVersion = String(bridge.value);
    }
    this.health = "healthy";
  }

  info(): BrowserRuntimeInfo {
    return {
      runtimeId: this.runtimeId,
      agentId: this.agentId,
      health: this.dead ? "dead" : this.health,
      pid: this.dead ? null : this.process.pid,
      cdpEndpoint: this.dead ? null : this.process.wsUrl,
      targetId: this.targetId,
      sessionId: this.sessionId,
      pageGeneration: this.pageGeneration,
      bridgeVersion: this.bridgeVersion,
      providerBuildFingerprint: null,
    };
  }

  async navigate(url: string): Promise<void> {
    this.assertAlive();
    this.startUrl = url;
    await this.waitForLoad(async () => {
      const res = await this.send<{ errorText?: string }>("Page.navigate", {
        url,
      });
      if (res?.errorText) {
        throw new Error(`Page.navigate failed for ${url}: ${res.errorText}`);
      }
    });
    this.pageGeneration += 1;
    await this.refreshBridgeVersion();
  }

  async reload(): Promise<void> {
    this.assertAlive();
    await this.waitForLoad(async () => {
      await this.send("Page.reload", {});
    });
    this.pageGeneration += 1;
    await this.refreshBridgeVersion();
  }

  async evaluate(expression: string, timeoutMs?: number): Promise<EvaluateResult> {
    this.assertAlive();
    try {
      const result = await this.send<{
        result?: { type?: string; value?: unknown; unserializableValue?: string };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
        timeoutMs,
      );
      if (result.exceptionDetails) {
        return {
          value: null,
          exception:
            result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "Runtime.evaluate exception",
        };
      }
      const r = result.result;
      if (!r) return { value: null };
      if (r.unserializableValue != null) return { value: r.unserializableValue };
      return { value: r.value };
    } catch (e) {
      return {
        value: null,
        exception: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async addScriptOnNewDocument(source: string): Promise<string> {
    this.assertAlive();
    if (!this.scripts.includes(source)) this.scripts.push(source);
    const res = await this.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source,
    });
    return res.identifier;
  }

  async destroy(): Promise<void> {
    this.dead = true;
    this.health = "dead";
    try {
      if (this.targetId) {
        await this.cdp
          .send({ method: "Target.closeTarget", params: { targetId: this.targetId } })
          .catch(() => undefined);
      }
    } finally {
      await this.cdp.close();
      await this.process.stop();
    }
  }

  private async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const cmd = this.sessionId ? { method, params, sessionId: this.sessionId } : { method, params };
    return this.cdp.send<T>(cmd, timeoutMs);
  }

  /**
   * Mark the session dead when the socket drops, the tab crashes, or the
   * user closes the agent tab — info().health then reports "dead" instead of
   * a stale "healthy".
   */
  private watchForDeath(): void {
    this.cdp.onClose(() => {
      this.dead = true;
      this.health = "dead";
    });
    this.cdp.onEvent((ev) => {
      const params = (ev.params ?? {}) as Record<string, unknown>;
      const forThisSession = !ev.sessionId || !this.sessionId || ev.sessionId === this.sessionId;
      if (!forThisSession) return;
      if (ev.method === "Inspector.targetCrashed") {
        this.dead = true;
        this.health = "dead";
        return;
      }
      if (ev.method === "Target.detachedFromTarget" && params.sessionId === this.sessionId) {
        this.dead = true;
        this.health = "dead";
        return;
      }
      if (ev.method === "Target.targetDestroyed" && params.targetId === this.targetId) {
        this.dead = true;
        this.health = "dead";
      }
    });
  }

  /**
   * Wait for a real load event on this session's frame. lifecycleEvent fires
   * per frame and per phase — only name === "load" counts. Navigation errors
   * (Page.navigate errorText) propagate. A missing load event (SPA push,
   * already-loaded page) resolves quietly after the timeout.
   */
  private async waitForLoad(action: () => Promise<void>): Promise<void> {
    let settled = false;
    let unsub: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadPromise = new Promise<void>((resolve) => {
      unsub = this.cdp.onEvent((ev) => {
        if (ev.sessionId && this.sessionId && ev.sessionId !== this.sessionId) return;
        const params = (ev.params ?? {}) as Record<string, unknown>;
        if (
          ev.method === "Page.loadEventFired" ||
          ev.method === "Page.domContentEventFired" ||
          (ev.method === "Page.lifecycleEvent" && params.name === "load")
        ) {
          if (!settled) {
            settled = true;
            unsub();
            if (timer) clearTimeout(timer);
            resolve();
          }
        }
      });
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          unsub();
          resolve();
        }
      }, 30_000);
    });
    try {
      await action();
      await loadPromise;
    } finally {
      if (!settled) {
        settled = true;
        unsub();
        if (timer) clearTimeout(timer);
      }
    }
    await sleep(50);
  }

  private async refreshBridgeVersion(): Promise<void> {
    const bridge = await this.evaluate(
      `(function(){ try { return window.__AIFROST_BRIDGE__ && window.__AIFROST_BRIDGE__.version; } catch(e) { return null; } })()`,
    );
    if (bridge.value != null && !bridge.exception) {
      this.bridgeVersion = String(bridge.value);
    }
  }

  private assertAlive(): void {
    if (this.dead) throw new Error("Chromium session is dead");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
