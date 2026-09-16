import type { BrowserSession } from "../browser/backend.js";
import type { BridgeDrainResult, PageBridgeHost } from "../providers/contract.js";

/**
 * Host-side PageBridgeCore client.
 * Uses Runtime.evaluate drain protocol (no Runtime.addBinding dependency).
 */
export class PageBridgeHostClient implements PageBridgeHost {
  constructor(private readonly session: BrowserSession) {}

  async invoke(command: Record<string, unknown>): Promise<unknown> {
    const json = JSON.stringify(command);
    // Pass command as JSON literal into evaluate
    const expression = `window.__AIFROST_BRIDGE__.invoke(${json})`;
    const result = await this.session.evaluate(expression);
    if (result.exception) {
      throw new Error(`bridge invoke failed: ${result.exception}`);
    }
    return result.value;
  }

  async drain(afterSeq: number, maxEvents = 100): Promise<BridgeDrainResult> {
    const expression = `window.__AIFROST_BRIDGE__.drain(${afterSeq}, ${maxEvents})`;
    const result = await this.session.evaluate(expression);
    if (result.exception) {
      throw new Error(`bridge drain failed: ${result.exception}`);
    }
    const value = result.value as BridgeDrainResult;
    return {
      events: value?.events ?? [],
      latestSeq: value?.latestSeq ?? afterSeq,
      overflow: Boolean(value?.overflow),
    };
  }

  async acknowledge(seq: number): Promise<void> {
    const expression = `window.__AIFROST_BRIDGE__.acknowledge(${seq})`;
    const result = await this.session.evaluate(expression);
    if (result.exception) {
      throw new Error(`bridge ack failed: ${result.exception}`);
    }
  }

  async ready(): Promise<boolean> {
    const result = await this.session.evaluate(`window.__AIFROST_BRIDGE__.state()`);
    if (result.exception) return false;
    const state = result.value as { ready?: boolean } | null;
    return Boolean(state?.ready);
  }
}
