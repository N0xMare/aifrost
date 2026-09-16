/**
 * Per-account ChatGPT Web rate-limit protocol (self-enforced).
 *
 * See docs/chatgpt-rate-limits.md. fixture-web is never gated.
 */

import { err } from "../types/errors.js";
import type { AccountId, AgentId } from "../types/ids.js";
import type { AccountRateLimitStore } from "../persistence/rate-limit-store.js";

export type RateLimitMode = "interactive" | "agentic" | "smoke" | "off";
export type RateLimitClass = "A" | "B" | "C";

export interface AccountRateLimitPolicy {
  enabled: boolean;
  mode: RateLimitMode;
  maxInflight: number;
  minSubmitGapMs: number;
  rollingWindowMs: number;
  rollingMaxSubmits: number;
  cooldownMs: number;
  maxCooldownMs: number;
  acquireWaitMs: number;
}

export interface AccountRateLimitOverride {
  enabled?: boolean;
  mode?: RateLimitMode;
  max_inflight?: number;
  min_submit_gap_ms?: number;
  rolling_window_ms?: number;
  rolling_max_submits?: number;
  cooldown_ms?: number;
  max_cooldown_ms?: number;
  acquire_wait_ms?: number;
}

export interface AccountRateLimitLiveState {
  inflight: number;
  submitsInWindow: number;
  cooldownUntil: string | null;
  lastSubmitEndedAt: string | null;
  lastClass: RateLimitClass | null;
}

export interface RateLimitSnapshot {
  account_id: string;
  enabled: boolean;
  mode: RateLimitMode;
  policy: {
    max_inflight: number;
    min_submit_gap_ms: number;
    rolling_window_ms: number;
    rolling_max_submits: number;
    cooldown_ms: number;
    max_cooldown_ms: number;
    acquire_wait_ms: number;
  };
  defaults: AccountRateLimitOverride;
  override: AccountRateLimitOverride | null;
  state: AccountRateLimitLiveState;
}

export interface RateLimitLease {
  accountId: AccountId;
  release: (opts?: { rateLimited?: boolean; klass?: RateLimitClass }) => void;
}

const MODE_PRESETS: Record<
  Exclude<RateLimitMode, "off">,
  Pick<AccountRateLimitPolicy, "minSubmitGapMs" | "rollingMaxSubmits">
> = {
  interactive: { minSubmitGapMs: 5_000, rollingMaxSubmits: 30 },
  agentic: { minSubmitGapMs: 10_000, rollingMaxSubmits: 24 },
  smoke: { minSubmitGapMs: 20_000, rollingMaxSubmits: 16 },
};

const UNGATED_PROVIDERS = new Set(["fixture-web"]);

export function parseRateLimitMode(raw: string | undefined): RateLimitMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "none" || v === "disabled") {
    return "off";
  }
  if (v === "interactive" || v === "agentic" || v === "smoke") return v;
  return "agentic";
}

export function defaultPolicyFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AccountRateLimitPolicy {
  const mode = parseRateLimitMode(env.AIFROST_RATE_LIMIT);
  const preset = mode === "off" ? MODE_PRESETS.agentic : MODE_PRESETS[mode];
  return {
    enabled: mode !== "off",
    mode,
    maxInflight: intEnv(env.AIFROST_RATE_MAX_INFLIGHT, 1, 1, 8),
    minSubmitGapMs: intEnv(env.AIFROST_RATE_MIN_SUBMIT_GAP_MS, preset.minSubmitGapMs, 0, 120_000),
    rollingWindowMs: intEnv(env.AIFROST_RATE_ROLLING_WINDOW_MS, 900_000, 60_000, 24 * 60 * 60_000),
    rollingMaxSubmits: intEnv(
      env.AIFROST_RATE_ROLLING_MAX_SUBMITS,
      preset.rollingMaxSubmits,
      1,
      10_000,
    ),
    cooldownMs: intEnv(env.AIFROST_RATE_COOLDOWN_MS, 300_000, 5_000, 3_600_000),
    maxCooldownMs: intEnv(env.AIFROST_RATE_MAX_COOLDOWN_MS, 1_800_000, 5_000, 6 * 3_600_000),
    acquireWaitMs: intEnv(env.AIFROST_RATE_ACQUIRE_WAIT_MS, 600_000, 0, 3_600_000),
  };
}

export function mergePolicy(
  base: AccountRateLimitPolicy,
  override: AccountRateLimitOverride | null | undefined,
): AccountRateLimitPolicy {
  if (!override || Object.keys(override).length === 0) return { ...base };
  const mode = override.mode ?? base.mode;
  const modeChanged = override.mode !== undefined && override.mode !== base.mode;
  // enabled precedence: explicit override.enabled wins (except mode "off",
  // which always gates off); otherwise off→disabled, and moving the mode
  // away from an "off" base re-enables.
  const enabled =
    override.enabled !== undefined
      ? override.enabled && mode !== "off"
      : mode === "off"
        ? false
        : base.mode === "off"
          ? true
          : base.enabled;
  const preset = mode === "off" ? MODE_PRESETS.agentic : MODE_PRESETS[mode];
  // Only reset gap/budget to the mode preset when the override actually
  // changes the mode — otherwise a tweak like {max_inflight:2} would stomp
  // env-configured AIFROST_RATE_MIN_SUBMIT_GAP_MS / ROLLING_MAX_SUBMITS.
  const fromMode: AccountRateLimitPolicy = {
    ...base,
    enabled,
    mode,
    minSubmitGapMs: modeChanged ? preset.minSubmitGapMs : base.minSubmitGapMs,
    rollingMaxSubmits: modeChanged ? preset.rollingMaxSubmits : base.rollingMaxSubmits,
  };
  return {
    enabled: fromMode.enabled,
    mode,
    maxInflight: clampInt(override.max_inflight, fromMode.maxInflight, 1, 8),
    minSubmitGapMs: clampInt(override.min_submit_gap_ms, fromMode.minSubmitGapMs, 0, 120_000),
    rollingWindowMs: clampInt(
      override.rolling_window_ms,
      fromMode.rollingWindowMs,
      60_000,
      24 * 60 * 60_000,
    ),
    rollingMaxSubmits: clampInt(
      override.rolling_max_submits,
      fromMode.rollingMaxSubmits,
      1,
      10_000,
    ),
    cooldownMs: clampInt(override.cooldown_ms, fromMode.cooldownMs, 5_000, 3_600_000),
    maxCooldownMs: clampInt(override.max_cooldown_ms, fromMode.maxCooldownMs, 5_000, 6 * 3_600_000),
    acquireWaitMs: clampInt(override.acquire_wait_ms, fromMode.acquireWaitMs, 0, 3_600_000),
  };
}

export function looksLikeChatGptLayerARateLimit(text: string): boolean {
  const t = text || "";
  if (/you['’]?re making requests too quickly/i.test(t)) return true;
  if (/temporarily limited access to your conversations/i.test(t)) return true;
  if (/too many requests/i.test(t) && /protect your data/i.test(t)) return true;
  if (/\brate_limited\b/i.test(t) && /conversation/i.test(t)) return true;
  return false;
}

export function looksLikeChatGptLayerCRateLimit(text: string): boolean {
  return /too many concurrent requests/i.test(text || "");
}

export function classifyRateLimitText(text: string): RateLimitClass | null {
  if (looksLikeChatGptLayerCRateLimit(text)) return "C";
  if (looksLikeChatGptLayerARateLimit(text)) return "A";
  if (/usage[_ ]limit|limit reached|you.?ve reached your (usage )?limit/i.test(text || "")) {
    return "B";
  }
  return null;
}

interface LiveState {
  inflight: number;
  submitEndedAt: number[];
  cooldownUntil: number | null;
  lastClass: RateLimitClass | null;
  strikes: number;
}

export interface AccountRateLimitControllerOpts {
  store?: AccountRateLimitStore | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AccountRateLimitController {
  private readonly defaults: AccountRateLimitPolicy;
  private readonly store: AccountRateLimitStore | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly live = new Map<string, LiveState>();
  private readonly overrideCache = new Map<string, AccountRateLimitOverride | null>();

  constructor(opts: AccountRateLimitControllerOpts = {}) {
    this.defaults = defaultPolicyFromEnv(
      opts.env ?? (process.env as Record<string, string | undefined>),
    );
    this.store = opts.store ?? null;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  globalDefaults(): AccountRateLimitPolicy {
    return { ...this.defaults };
  }

  policyFor(accountId: string): AccountRateLimitPolicy {
    return mergePolicy(this.defaults, this.overrideFor(accountId));
  }

  snapshot(accountId: string): RateLimitSnapshot {
    const override = this.overrideFor(accountId);
    const policy = mergePolicy(this.defaults, override);
    const live = this.live.get(accountId) ?? emptyLive();
    const now = this.now();
    const windowStart = now - policy.rollingWindowMs;
    const submitsInWindow = live.submitEndedAt.filter((t) => t > windowStart).length;
    return {
      account_id: accountId,
      enabled: policy.enabled,
      mode: policy.mode,
      policy: {
        max_inflight: policy.maxInflight,
        min_submit_gap_ms: policy.minSubmitGapMs,
        rolling_window_ms: policy.rollingWindowMs,
        rolling_max_submits: policy.rollingMaxSubmits,
        cooldown_ms: policy.cooldownMs,
        max_cooldown_ms: policy.maxCooldownMs,
        acquire_wait_ms: policy.acquireWaitMs,
      },
      defaults: policyToOverride(this.defaults),
      override,
      state: {
        inflight: live.inflight,
        submitsInWindow,
        cooldownUntil:
          live.cooldownUntil && live.cooldownUntil > now
            ? new Date(live.cooldownUntil).toISOString()
            : null,
        lastSubmitEndedAt:
          live.submitEndedAt.length > 0
            ? new Date(live.submitEndedAt[live.submitEndedAt.length - 1]!).toISOString()
            : null,
        lastClass: live.lastClass,
      },
    };
  }

  setOverride(accountId: string, patch: AccountRateLimitOverride): RateLimitSnapshot {
    const prev = this.overrideFor(accountId) ?? {};
    const next = sanitizeOverride({ ...prev, ...patch });
    this.overrideCache.set(accountId, next);
    this.store?.put(accountId, next);
    return this.snapshot(accountId);
  }

  clearOverride(accountId: string): RateLimitSnapshot {
    this.overrideCache.set(accountId, null);
    this.store?.delete(accountId);
    return this.snapshot(accountId);
  }

  /**
   * Acquire a submit lease. fixture-web and disabled policies are no-ops.
   * Throws AifrostException 429 on cooldown / rolling budget / wait timeout.
   */
  async acquire(opts: {
    accountId: AccountId | string;
    providerId: string;
    agentId?: AgentId | string;
  }): Promise<RateLimitLease | null> {
    if (UNGATED_PROVIDERS.has(opts.providerId)) return null;
    const accountId = String(opts.accountId);
    const policy = this.policyFor(accountId);
    if (!policy.enabled) return null;

    const started = this.now();
    while (true) {
      const decision = this.evaluate(accountId, policy);
      if (decision.kind === "deny") {
        throw rateLimitedError(decision.message, decision.retryAfterMs, {
          accountId,
          agentId: opts.agentId,
          klass: decision.klass,
        });
      }
      if (decision.kind === "allow") {
        const live = this.ensureLive(accountId);
        live.inflight += 1;
        let released = false;
        return {
          accountId: accountId as AccountId,
          release: (rel) => {
            if (released) return;
            released = true;
            live.inflight = Math.max(0, live.inflight - 1);
            // Rolling window timestamps are recorded per WebUI submit
            // (afterWebUiSubmit), not once per generation.
            this.pruneTimestamps(live, policy);
            if (rel?.rateLimited) {
              this.noteLimited(accountId, rel.klass ?? "A");
            }
          },
        };
      }
      const waited = this.now() - started;
      if (waited + decision.waitMs > policy.acquireWaitMs) {
        throw rateLimitedError(
          `Timed out waiting ${policy.acquireWaitMs}ms for account ${accountId} rate-limit gate ` +
            `(${decision.reason}). Slow down or raise AIFROST_RATE_ACQUIRE_WAIT_MS.`,
          decision.waitMs,
          { accountId, agentId: opts.agentId, klass: "C" },
        );
      }
      await this.sleep(Math.max(20, Math.min(decision.waitMs, 1_000)));
    }
  }

  noteLimited(accountId: string, klass: RateLimitClass = "A"): void {
    const policy = this.policyFor(accountId);
    const live = this.ensureLive(accountId);
    live.lastClass = klass;
    live.strikes += 1;
    const raw =
      klass === "C"
        ? 30_000
        : klass === "B"
          ? Math.max(policy.cooldownMs, 600_000)
          : policy.cooldownMs * 2 ** Math.max(0, live.strikes - 1);
    const ms = Math.min(policy.maxCooldownMs, raw);
    const until = this.now() + ms;
    live.cooldownUntil = live.cooldownUntil ? Math.max(live.cooldownUntil, until) : until;
  }

  private evaluate(
    accountId: string,
    policy: AccountRateLimitPolicy,
  ):
    | { kind: "allow" }
    | { kind: "wait"; waitMs: number; reason: string }
    | {
        kind: "deny";
        message: string;
        retryAfterMs: number;
        klass: RateLimitClass;
      } {
    const now = this.now();
    const live = this.ensureLive(accountId);
    if (live.cooldownUntil && live.cooldownUntil > now) {
      const retryAfterMs = live.cooldownUntil - now;
      return {
        kind: "deny",
        klass: live.lastClass ?? "A",
        retryAfterMs,
        message:
          `Account ${accountId} is in ChatGPT rate-limit cooldown ` +
          `(${Math.ceil(retryAfterMs / 1000)}s remaining; class ${live.lastClass ?? "A"}). ` +
          `Wait before sending another WebUI turn.`,
      };
    }
    this.pruneTimestamps(live, policy);
    if (live.submitEndedAt.length >= policy.rollingMaxSubmits) {
      const oldest = live.submitEndedAt[0]!;
      const retryAfterMs = Math.max(1, oldest + policy.rollingWindowMs - now);
      return {
        kind: "deny",
        klass: "A",
        retryAfterMs,
        message:
          `Account ${accountId} hit rolling WebUI submit budget ` +
          `(${policy.rollingMaxSubmits} / ${Math.round(policy.rollingWindowMs / 1000)}s). ` +
          `Retry after ${Math.ceil(retryAfterMs / 1000)}s or raise rolling_max_submits.`,
      };
    }
    if (live.inflight >= policy.maxInflight) {
      return {
        kind: "wait",
        waitMs: 250,
        reason: `inflight=${live.inflight}>=${policy.maxInflight}`,
      };
    }
    return { kind: "allow" };
  }

  /**
   * Pace a real chatgpt.com composer submit (primary, corrective, or nudge).
   * Waits min gap; throws 429 on cooldown / rolling budget.
   */
  async beforeWebUiSubmit(opts: { accountId: string; providerId: string }): Promise<void> {
    if (UNGATED_PROVIDERS.has(opts.providerId)) return;
    const accountId = opts.accountId;
    const policy = this.policyFor(accountId);
    if (!policy.enabled) return;
    const started = this.now();
    while (true) {
      const now = this.now();
      const live = this.ensureLive(accountId);
      if (live.cooldownUntil && live.cooldownUntil > now) {
        throw rateLimitedError(
          `Account ${accountId} is in ChatGPT rate-limit cooldown ` +
            `(${Math.ceil((live.cooldownUntil - now) / 1000)}s remaining).`,
          live.cooldownUntil - now,
          { accountId, klass: live.lastClass ?? "A" },
        );
      }
      this.pruneTimestamps(live, policy);
      if (live.submitEndedAt.length >= policy.rollingMaxSubmits) {
        const oldest = live.submitEndedAt[0]!;
        const retryAfterMs = Math.max(1, oldest + policy.rollingWindowMs - now);
        throw rateLimitedError(
          `Account ${accountId} hit rolling WebUI submit budget ` +
            `(${policy.rollingMaxSubmits} / ${Math.round(policy.rollingWindowMs / 1000)}s).`,
          retryAfterMs,
          { accountId, klass: "A" },
        );
      }
      const last = live.submitEndedAt[live.submitEndedAt.length - 1];
      if (last != null && now - last < policy.minSubmitGapMs) {
        const waitMs = policy.minSubmitGapMs - (now - last);
        if (this.now() - started + waitMs > policy.acquireWaitMs) {
          throw rateLimitedError(`Timed out waiting for min submit gap on ${accountId}`, waitMs, {
            accountId,
            klass: "C",
          });
        }
        await this.sleep(Math.max(20, Math.min(waitMs, 1_000)));
        continue;
      }
      return;
    }
  }

  afterWebUiSubmit(accountId: string, providerId: string): void {
    if (UNGATED_PROVIDERS.has(providerId)) return;
    const policy = this.policyFor(accountId);
    if (!policy.enabled) return;
    const live = this.ensureLive(accountId);
    live.submitEndedAt.push(this.now());
    this.pruneTimestamps(live, policy);
  }

  private overrideFor(accountId: string): AccountRateLimitOverride | null {
    if (this.overrideCache.has(accountId)) {
      return this.overrideCache.get(accountId) ?? null;
    }
    const loaded = this.store?.get(accountId) ?? null;
    this.overrideCache.set(accountId, loaded);
    return loaded;
  }

  private ensureLive(accountId: string): LiveState {
    let s = this.live.get(accountId);
    if (!s) {
      s = emptyLive();
      this.live.set(accountId, s);
    }
    return s;
  }

  private pruneTimestamps(live: LiveState, policy: AccountRateLimitPolicy): void {
    const cut = this.now() - policy.rollingWindowMs;
    live.submitEndedAt = live.submitEndedAt.filter((t) => t > cut);
  }
}

function emptyLive(): LiveState {
  return {
    inflight: 0,
    submitEndedAt: [],
    cooldownUntil: null,
    lastClass: null,
    strikes: 0,
  };
}

function rateLimitedError(
  message: string,
  retryAfterMs: number,
  opts: { accountId: string; agentId?: string; klass: RateLimitClass },
) {
  return err("rate_limited", message, 429, {
    retryable: true,
    agentId: opts.agentId as AgentId | undefined,
    details: {
      account_id: opts.accountId,
      retry_after_ms: retryAfterMs,
      class: opts.klass,
    },
  });
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function sanitizeOverride(patch: AccountRateLimitOverride): AccountRateLimitOverride {
  const out: AccountRateLimitOverride = {};
  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  if (patch.mode) {
    const m = parseRateLimitMode(patch.mode);
    // parseRateLimitMode defaults unknown → agentic; only accept explicit
    const raw = String(patch.mode).trim().toLowerCase();
    if (raw === "off" || raw === "interactive" || raw === "agentic" || raw === "smoke") {
      out.mode = m;
    }
  }
  if (patch.max_inflight !== undefined) out.max_inflight = patch.max_inflight;
  if (patch.min_submit_gap_ms !== undefined) {
    out.min_submit_gap_ms = patch.min_submit_gap_ms;
  }
  if (patch.rolling_window_ms !== undefined) {
    out.rolling_window_ms = patch.rolling_window_ms;
  }
  if (patch.rolling_max_submits !== undefined) {
    out.rolling_max_submits = patch.rolling_max_submits;
  }
  if (patch.cooldown_ms !== undefined) out.cooldown_ms = patch.cooldown_ms;
  if (patch.max_cooldown_ms !== undefined) out.max_cooldown_ms = patch.max_cooldown_ms;
  if (patch.acquire_wait_ms !== undefined) out.acquire_wait_ms = patch.acquire_wait_ms;
  return out;
}

function policyToOverride(p: AccountRateLimitPolicy): AccountRateLimitOverride {
  return {
    enabled: p.enabled,
    mode: p.mode,
    max_inflight: p.maxInflight,
    min_submit_gap_ms: p.minSubmitGapMs,
    rolling_window_ms: p.rollingWindowMs,
    rolling_max_submits: p.rollingMaxSubmits,
    cooldown_ms: p.cooldownMs,
    max_cooldown_ms: p.maxCooldownMs,
    acquire_wait_ms: p.acquireWaitMs,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
