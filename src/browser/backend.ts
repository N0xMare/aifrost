/**
 * BrowserBackend / BrowserSession
 *
 * Isolates Chromium/Brave (and test mock) from agents, providers, and APIs.
 * HTTP handlers and protocol adapters MUST NOT call CDP directly.
 */

import type { AgentId, RuntimeId } from "../types/ids.js";

export interface BrowserStartConfig {
  /** Preferred loopback host for browser CDP listeners. */
  host?: string;
  /** Chromium/Brave binary override (also AIFROST_CHROMIUM_BIN / AIFROST_BRAVE_BIN). */
  chromiumBinary?: string;
  stateDir?: string;
}

export interface AgentRuntimeConfig {
  agentId: AgentId;
  accountId: string;
  /** Initial URL or about:blank */
  startUrl: string;
  /** Script source injected via Page.addScriptToEvaluateOnNewDocument */
  documentStartScripts?: string[];
}

export type BrowserRuntimeHealth = "starting" | "healthy" | "degraded" | "dead";

export interface BrowserRuntimeInfo {
  runtimeId: RuntimeId;
  agentId: AgentId;
  health: BrowserRuntimeHealth;
  pid: number | null;
  cdpEndpoint: string | null;
  targetId: string | null;
  sessionId: string | null;
  pageGeneration: number;
  bridgeVersion: string | null;
  providerBuildFingerprint: string | null;
}

export interface EvaluateResult {
  value: unknown;
  exception?: string;
}

export interface BrowserSession {
  readonly runtimeId: RuntimeId;
  readonly agentId: AgentId;

  info(): BrowserRuntimeInfo;

  navigate(url: string): Promise<void>;
  reload(): Promise<void>;

  /** Evaluate JS in the page world; used for bridge drain/commands only. */
  evaluate(expression: string, timeoutMs?: number): Promise<EvaluateResult>;

  /** Install document-start scripts (before navigation when possible). */
  addScriptOnNewDocument(source: string): Promise<string>;
}

export interface BrowserBackend {
  start(config: BrowserStartConfig): Promise<void>;
  createRuntime(agent: AgentRuntimeConfig): Promise<BrowserSession>;
  destroyRuntime(runtimeId: RuntimeId): Promise<void>;
  getRuntime(runtimeId: RuntimeId): BrowserSession | undefined;
  shutdown(): Promise<void>;
}
