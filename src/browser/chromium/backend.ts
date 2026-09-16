/**
 * ChromiumBrowserBackend — production BrowserBackend for Aifrost.
 *
 * Isolation model (v1 product):
 * - One headed Brave/Chrome **process per account_id** (separate --user-data-dir).
 * - Many agents on the same account = many **tabs** (CDP targets) in that process.
 * - Personal Brave is never touched.
 *
 * Sticky processes (default): the account browser stays up for the life of
 * `aifrost serve` even when the last agent releases, so the Dock does not thrash.
 * Set AIFROST_BROWSER_IDLE_EXIT=1 to kill the process when refcount hits 0.
 *
 * Caps: AIFROST_MAX_TABS_PER_ACCOUNT (default 10) bounds concurrent agent tabs
 * per account process.
 *
 * Future (not Brave UI "Containers" API): single process + CDP BrowserContext
 * per account for multi-login in one process — needs durable storage design.
 * See docs/browser-isolation.md.
 */

import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import type {
  AgentRuntimeConfig,
  BrowserBackend,
  BrowserSession,
  BrowserStartConfig,
} from "../backend.js";
import type { RuntimeId } from "../../types/ids.js";
import { isValidAccountId, newRuntimeId } from "../../types/ids.js";
import { err } from "../../types/errors.js";
import { resolveChromiumBinary, detectBrowserBrand } from "./resolve-binary.js";
import {
  isCdpHttpReady,
  killProcessesUsingUserDataDir,
  startChromiumProcess,
  type ChromiumProcessHandle,
} from "./process.js";
import { ChromiumBrowserSession } from "./session.js";

export interface ChromiumBackendOptions {
  binaryPath?: string;
  /** Default true for production; tests may set false and use mock instead. */
  requireBinary?: boolean;
  headless?: boolean;
  stateDir?: string;
  /** Max concurrent agent tabs (CDP pages) per account process. */
  maxTabsPerAccount?: number;
  /**
   * When true, kill the profile browser when the last agent releases.
   * Default false (sticky until backend.shutdown).
   */
  idleExit?: boolean;
}

interface ProfileProcessEntry {
  handle: ChromiumProcessHandle;
  /** Number of agent runtimes using this profile process. */
  refs: number;
  /** Real stop for the underlying child (may no-op if attached to existing). */
  hardStop: () => Promise<void>;
  accountId: string;
}

/** Parse AIFROST_MAX_TABS_PER_ACCOUNT (default 10, min 1, max 50). */
export function resolveMaxTabsPerAccount(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return clampInt(override, 1, 50);
  }
  const raw = (env.AIFROST_MAX_TABS_PER_ACCOUNT ?? "10").trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return clampInt(n, 1, 50);
}

/** Parse AIFROST_BROWSER_IDLE_EXIT (default false = sticky). */
export function resolveBrowserIdleExit(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  override?: boolean,
): boolean {
  if (typeof override === "boolean") return override;
  const raw = (env.AIFROST_BROWSER_IDLE_EXIT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export class ChromiumBrowserBackend implements BrowserBackend {
  private started = false;
  private config: BrowserStartConfig = {};
  private readonly sessions = new Map<RuntimeId, ChromiumBrowserSession>();
  private readonly runtimeProfile = new Map<RuntimeId, string>();
  private readonly profileProcesses = new Map<string, ProfileProcessEntry>();
  private readonly pendingProfiles = new Map<string, Promise<ProfileProcessEntry>>();
  private binaryPath: string | null;
  private readonly requireBinary: boolean;
  private readonly headless: boolean;
  private stateDir: string;
  private readonly maxTabsPerAccount: number;
  private readonly idleExit: boolean;

  constructor(opts: ChromiumBackendOptions = {}) {
    this.binaryPath = resolveChromiumBinary(opts.binaryPath);
    this.requireBinary = opts.requireBinary ?? true;
    // Default headed: ChatGPT CF blocks headless Brave/Chrome with saved profiles.
    this.headless =
      opts.headless ??
      (process.env.AIFROST_HEADLESS === "1" || process.env.AIFROST_HEADLESS === "true");
    this.stateDir = opts.stateDir ?? process.env.AIFROST_STATE_DIR ?? "./state";
    this.maxTabsPerAccount = resolveMaxTabsPerAccount(
      process.env as Record<string, string | undefined>,
      opts.maxTabsPerAccount,
    );
    this.idleExit = resolveBrowserIdleExit(
      process.env as Record<string, string | undefined>,
      opts.idleExit,
    );
  }

  async start(config: BrowserStartConfig): Promise<void> {
    this.config = config;
    if (config.stateDir) this.stateDir = config.stateDir;
    if (config.chromiumBinary) {
      this.binaryPath = resolveChromiumBinary(config.chromiumBinary);
    }
    if (!this.binaryPath) {
      this.binaryPath = resolveChromiumBinary();
    }
    if (!this.binaryPath && this.requireBinary) {
      throw err(
        "agent_unavailable",
        "No Chromium/Brave binary found. Install Brave or Chrome, or set AIFROST_CHROMIUM_BIN / AIFROST_BRAVE_BIN.",
        503,
        { retryable: false },
      );
    }
    // Do not kill profile browsers on start — sticky reuse across restarts is
    // intentional when DevToolsActivePort is still live. Orphans without CDP
    // are cleaned inside startChromiumProcess before a clean relaunch.
    this.started = true;
  }

  binaryAvailable(): boolean {
    if (this.binaryPath) return true;
    this.binaryPath = resolveChromiumBinary();
    return Boolean(this.binaryPath);
  }

  getBinaryPath(): string | null {
    return this.binaryPath;
  }

  getBrand(): string {
    return this.binaryPath ? detectBrowserBrand(this.binaryPath) : "unknown";
  }

  /** Test/observability: concurrent tabs for a profile dir. */
  tabCountForProfile(profileDir: string): number {
    let n = 0;
    for (const dir of this.runtimeProfile.values()) {
      if (dir === profileDir) n += 1;
    }
    return n;
  }

  async createRuntime(agent: AgentRuntimeConfig): Promise<BrowserSession> {
    if (!this.started) throw new Error("ChromiumBrowserBackend not started");
    if (!this.binaryPath) {
      throw err("agent_unavailable", "Chromium/Brave binary not available", 503);
    }
    // account_id becomes a filesystem path + pgrep pattern — validate here too
    // (defense in depth behind the API boundary check).
    if (!isValidAccountId(agent.accountId)) {
      throw err(
        "invalid_request",
        `account_id must match ^[A-Za-z0-9_-]{1,64}$ (got "${agent.accountId}")`,
        400,
      );
    }

    const runtimeId = newRuntimeId();
    const profileDir = join(this.stateDir, "profiles", agent.accountId, "chromium");

    const openTabs = this.tabCountForProfile(profileDir);
    if (openTabs >= this.maxTabsPerAccount) {
      throw err(
        "agent_unavailable",
        `Account "${agent.accountId}" already has ${openTabs} open Aifrost tab(s) ` +
          `(limit AIFROST_MAX_TABS_PER_ACCOUNT=${this.maxTabsPerAccount}). ` +
          `Delete unused agents or raise the limit.`,
        503,
        { retryable: false, details: { accountId: agent.accountId } },
      );
    }

    const entry = await this.acquireProfileProcess(profileDir, agent.accountId);
    const proc = entry.handle;

    // Session must not kill shared profile process on destroy — refcount does.
    const sessionProcess: ChromiumProcessHandle = {
      ...proc,
      shared: true,
      stop: async () => {
        /* refcounted in destroyRuntime / sticky policy */
      },
    };

    const session = new ChromiumBrowserSession({
      runtimeId,
      agentId: agent.agentId,
      process: sessionProcess,
      startUrl: agent.startUrl,
      documentStartScripts: agent.documentStartScripts,
    });

    try {
      await session.bootstrap();
    } catch (e) {
      await session.destroy().catch(() => undefined);
      await this.releaseProfileProcess(profileDir);
      throw e;
    }

    this.sessions.set(runtimeId, session);
    this.runtimeProfile.set(runtimeId, profileDir);
    return session;
  }

  private async acquireProfileProcess(
    profileDir: string,
    accountId: string,
  ): Promise<ProfileProcessEntry> {
    const existing = this.profileProcesses.get(profileDir);
    if (existing) {
      // Sticky entries can outlive their browser — revalidate the CDP
      // endpoint before reusing so a dead process is relaunched, not reused.
      const alive = await isCdpHttpReady(existing.handle.host, existing.handle.port, 800);
      if (alive) {
        existing.refs += 1;
        return existing;
      }
      this.profileProcesses.delete(profileDir);
    }

    // Serialize concurrent acquisitions for the same profile: two agents
    // racing a launch must not spawn two processes on one --user-data-dir
    // (the second would kill the first mid-bootstrap).
    const pending = this.pendingProfiles.get(profileDir);
    if (pending) {
      const entry = await pending;
      entry.refs += 1;
      return entry;
    }

    const start = (async (): Promise<ProfileProcessEntry> => {
      const handle = await startChromiumProcess({
        binaryPath: this.binaryPath!,
        userDataDir: profileDir,
        host: this.config.host ?? "127.0.0.1",
        headless: this.headless,
      });

      // Capture real stop before we mark shared
      const hardStop = () => handle.stop();
      const entry: ProfileProcessEntry = {
        handle: {
          ...handle,
          shared: true,
          stop: async () => {
            /* no-op; use hardStop via refcount / shutdown */
          },
        },
        refs: 1,
        hardStop,
        accountId,
      };
      this.profileProcesses.set(profileDir, entry);
      return entry;
    })();

    this.pendingProfiles.set(profileDir, start);
    try {
      return await start;
    } finally {
      this.pendingProfiles.delete(profileDir);
    }
  }

  private async releaseProfileProcess(profileDir: string): Promise<void> {
    const entry = this.profileProcesses.get(profileDir);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;

    // Sticky: keep process + map entry so the next agent reuses without Dock thrash.
    if (!this.idleExit) {
      entry.refs = 0;
      return;
    }

    this.profileProcesses.delete(profileDir);
    try {
      await entry.hardStop();
    } catch {
      await killProcessesUsingUserDataDir(profileDir);
    }
  }

  async destroyRuntime(runtimeId: RuntimeId): Promise<void> {
    const session = this.sessions.get(runtimeId);
    this.sessions.delete(runtimeId);
    const profileDir = this.runtimeProfile.get(runtimeId);
    this.runtimeProfile.delete(runtimeId);
    try {
      if (session) await session.destroy();
    } finally {
      // Always release the profile refcount — a session destroy failure must
      // not wedge the refcount (idleExit would never kill the process).
      if (profileDir) await this.releaseProfileProcess(profileDir);
    }
  }

  getRuntime(runtimeId: RuntimeId): BrowserSession | undefined {
    return this.sessions.get(runtimeId);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.destroyRuntime(id);
    }
    // Always tear down sticky processes on serve exit.
    for (const [dir, entry] of [...this.profileProcesses.entries()]) {
      try {
        await entry.hardStop();
      } catch {
        await killProcessesUsingUserDataDir(dir);
      }
      this.profileProcesses.delete(dir);
    }
    // Sweep any orphan profile browsers under state/profiles/*/chromium
    await this.killAllKnownProfileOrphans();
    this.started = false;
  }

  /** Kill leftover Brave/Chrome processes for every profile dir we know on disk. */
  private async killAllKnownProfileOrphans(): Promise<void> {
    const profilesRoot = join(this.stateDir, "profiles");
    if (!existsSync(profilesRoot)) return;
    let accountDirs: string[] = [];
    try {
      accountDirs = readdirSync(profilesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const accountId of accountDirs) {
      const chromiumDir = join(profilesRoot, accountId, "chromium");
      if (existsSync(chromiumDir)) {
        try {
          await killProcessesUsingUserDataDir(chromiumDir);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}
