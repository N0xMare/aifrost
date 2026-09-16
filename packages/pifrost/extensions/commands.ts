/**
 * /aifrost command handlers (pure-ish logic + injectable deps for tests).
 */

import type { AifrostConfig } from "./config.js";
import {
  createAgent,
  deleteAgent,
  getAccountRateLimit,
  getGlobalRateLimit,
  healthCheck,
  listAgents,
  patchAccountRateLimit,
  type AifrostAgent,
  AifrostClientError,
} from "./client.js";

export type NotifyLevel = "info" | "warning" | "error";

export interface CommandUi {
  notify(message: string, level?: NotifyLevel): void;
}

export interface RefreshResult {
  agents: AifrostAgent[];
  /** Non-null when list/health/auth failed; provider may still be re-registered empty. */
  error: string | null;
}

export interface CommandDeps {
  config: AifrostConfig;
  /** Fetch agents and re-register the provider. */
  refresh: () => Promise<RefreshResult>;
  /** Optional override for health (tests). */
  healthCheck?: typeof healthCheck;
  listAgents?: typeof listAgents;
  createAgent?: typeof createAgent;
  deleteAgent?: typeof deleteAgent;
  getAccountRateLimit?: typeof getAccountRateLimit;
  getGlobalRateLimit?: typeof getGlobalRateLimit;
  patchAccountRateLimit?: typeof patchAccountRateLimit;
}

const HELP_TEXT = [
  "Aifrost (pifrost) — thin Pi adapter over Aifrost provider API:",
  "  /aifrost status                         — health + agent count",
  "  /aifrost agents                         — list id / provider / account / lifecycle",
  "  /aifrost refresh                        — re-fetch agents and re-register models",
  "  /aifrost create [account] [provider]    — default: acct_default fixture-web",
  "      coding: /aifrost create acct_main chatgpt-web",
  "  /aifrost prune                          — delete fixture-web + failed agents (keeps ChatGPT)",
  "  /aifrost clear                          — delete ALL agents (clean slate for smoke tests)",
  "  /aifrost ratelimit [status] [account]   — show account pace / cooldown",
  "  /aifrost ratelimit set <account> k=v    — override (mode=interactive min_submit_gap_ms=8000)",
  "  /aifrost ratelimit off <account>        — disable self-enforced limit for account",
  "  /aifrost ratelimit defaults             — server env defaults",
  "  /aifrost help                           — this text",
  "",
  "Also: just clear-aifrost  (repo justfile, same as clear)",
  "AIFROST_MODELS=chatgpt (default) hides Fixture(Echo) from /model.",
  "Aifrost owns conversation state; pick one ChatGPT agent per Pi thread.",
  "HTTP 429 rate_limited: wait retry_after_ms. 503 tool_scaffold_incomplete: retry the same turn.",
].join("\n");

export function parseAifrostArgs(args: string): {
  sub: string;
  rest: string[];
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "help").toLowerCase();
  return { sub, rest: parts.slice(1) };
}

const KNOWN_PROVIDERS = new Set(["fixture-web", "chatgpt-web"]);

/**
 * /aifrost create [account_id] [provider]
 * /aifrost create [provider]  (if first token is a known provider)
 * Defaults: account=acct_default, provider=fixture-web (safe for mock/local).
 */
export function parseCreateArgs(rest: string[]): {
  accountId: string;
  provider: string;
} {
  const a = rest[0]?.trim();
  const b = rest[1]?.trim();
  if (!a) {
    return { accountId: "acct_default", provider: "fixture-web" };
  }
  if (KNOWN_PROVIDERS.has(a) && !b) {
    return { accountId: "acct_default", provider: a };
  }
  if (KNOWN_PROVIDERS.has(a) && b) {
    // create fixture-web acct_pi  OR  create chatgpt-web acct_main
    return { accountId: b, provider: a };
  }
  if (b && KNOWN_PROVIDERS.has(b)) {
    return { accountId: a, provider: b };
  }
  // create acct_pi  → fixture-web
  return { accountId: a, provider: b && b.length > 0 ? b : "fixture-web" };
}

export async function handleAifrostCommand(
  args: string,
  ui: CommandUi,
  deps: CommandDeps,
): Promise<void> {
  const { sub, rest } = parseAifrostArgs(args);
  const cfg = deps.config;
  const doHealth = deps.healthCheck ?? healthCheck;
  const doList = deps.listAgents ?? listAgents;
  const doCreate = deps.createAgent ?? createAgent;
  const doDelete = deps.deleteAgent ?? deleteAgent;

  try {
    switch (sub) {
      case "help":
      case "":
        ui.notify(HELP_TEXT, "info");
        return;

      case "status": {
        const health = await doHealth(cfg.baseUrl, cfg.authToken);
        let count = 0;
        let listNote = cfg.authHeader ? "" : " (auth=none)";
        try {
          const agents = await doList(cfg.baseUrl, cfg.authToken);
          count = agents.filter((a) => a.lifecycle !== "deleted").length;
        } catch (err) {
          listNote = ` (list failed: ${errorMessage(err)})`;
        }
        const ok = health.ok ? "ok" : "not ok";
        ui.notify(
          `Aifrost ${ok} @ ${cfg.baseUrl} — ${count} agent(s)${listNote}`,
          health.ok ? "info" : "warning",
        );
        return;
      }

      case "agents": {
        const agents = await doList(cfg.baseUrl, cfg.authToken);
        const active = agents.filter((a) => a.lifecycle !== "deleted");
        if (active.length === 0) {
          ui.notify("No Aifrost agents.", "info");
          return;
        }
        const lines = active.map((a) => `${a.id}  ${a.provider}  ${a.account_id}  ${a.lifecycle}`);
        ui.notify(`Aifrost agents (${active.length}):\n${lines.join("\n")}`, "info");
        return;
      }

      case "refresh": {
        const result = await deps.refresh();
        if (result.error) {
          ui.notify(`Aifrost refresh failed: ${result.error}`, "error");
          return;
        }
        const n = result.agents.filter((a) => a.lifecycle !== "deleted").length;
        ui.notify(`Aifrost provider refreshed — ${n} model(s).`, "info");
        return;
      }

      case "create": {
        const { accountId, provider } = parseCreateArgs(rest);
        const created = await doCreate(cfg.baseUrl, cfg.authToken, {
          provider,
          account_id: accountId,
        });
        const after = await deps.refresh();
        if (after.error) {
          ui.notify(`Created agent ${created.id}, but refresh failed: ${after.error}`, "warning");
          return;
        }
        ui.notify(
          `Created ${created.id} (${provider} / ${accountId}). Run /model and select this id.`,
          "info",
        );
        return;
      }

      case "prune": {
        const agents = await doList(cfg.baseUrl, cfg.authToken);
        const victims = agents.filter(
          (a) =>
            a.lifecycle !== "deleted" &&
            (a.provider === "fixture-web" ||
              a.lifecycle === "failed" ||
              a.lifecycle === "deleting"),
        );
        if (victims.length === 0) {
          ui.notify("Nothing to prune (no fixture/failed agents).", "info");
          return;
        }
        let n = 0;
        for (const a of victims) {
          try {
            await doDelete(cfg.baseUrl, cfg.authToken, a.id);
            n += 1;
          } catch {
            /* continue */
          }
        }
        await deps.refresh();
        ui.notify(`Pruned ${n} agent(s). /model now prefers remaining ChatGPT agents.`, "info");
        return;
      }

      case "clear":
      case "clear-all":
      case "reset": {
        const agents = await doList(cfg.baseUrl, cfg.authToken);
        const victims = agents.filter((a) => a.lifecycle !== "deleted");
        if (victims.length === 0) {
          ui.notify("No agents to clear.", "info");
          return;
        }
        let n = 0;
        for (const a of victims) {
          try {
            await doDelete(cfg.baseUrl, cfg.authToken, a.id);
            n += 1;
          } catch {
            /* continue */
          }
        }
        await deps.refresh();
        ui.notify(
          `Cleared ${n} agent(s). Create a fresh one: /aifrost create acct_main chatgpt-web`,
          "info",
        );
        return;
      }

      case "ratelimit":
      case "rate-limit":
      case "rl": {
        await handleRateLimitCommand(rest, ui, {
          config: cfg,
          getAccountRateLimit: deps.getAccountRateLimit ?? getAccountRateLimit,
          getGlobalRateLimit: deps.getGlobalRateLimit ?? getGlobalRateLimit,
          patchAccountRateLimit: deps.patchAccountRateLimit ?? patchAccountRateLimit,
        });
        return;
      }

      default:
        ui.notify(`Unknown /aifrost subcommand "${sub}". Try /aifrost help.`, "warning");
    }
  } catch (err) {
    ui.notify(errorMessage(err), "error");
  }
}

async function handleRateLimitCommand(
  rest: string[],
  ui: CommandUi,
  deps: {
    config: AifrostConfig;
    getAccountRateLimit: typeof getAccountRateLimit;
    getGlobalRateLimit: typeof getGlobalRateLimit;
    patchAccountRateLimit: typeof patchAccountRateLimit;
  },
): Promise<void> {
  const cfg = deps.config;
  const action = (rest[0] ?? "status").toLowerCase();

  if (action === "defaults" || action === "default") {
    const d = await deps.getGlobalRateLimit(cfg.baseUrl, cfg.authToken);
    ui.notify(`Aifrost rate-limit defaults:\n${formatJson(d)}`, "info");
    return;
  }

  if (action === "off" || action === "disable") {
    const account = rest[1] || "acct_main";
    const snap = await deps.patchAccountRateLimit(cfg.baseUrl, cfg.authToken, account, {
      enabled: false,
      mode: "off",
    });
    ui.notify(`Rate limit disabled for ${account} (mode=${snap.mode}).`, "info");
    return;
  }

  if (action === "set") {
    const account = rest[1];
    const pairs = rest.slice(account && !account.includes("=") ? 2 : 1);
    const accountId = account && !account.includes("=") ? account : "acct_main";
    const body = parseKvPairs(pairs);
    if (Object.keys(body).length === 0) {
      ui.notify(
        "Usage: /aifrost ratelimit set <account> mode=interactive min_submit_gap_ms=8000",
        "warning",
      );
      return;
    }
    const snap = await deps.patchAccountRateLimit(cfg.baseUrl, cfg.authToken, accountId, body);
    ui.notify(formatRateLimitSnap(snap), "info");
    return;
  }

  if (action === "reset" || action === "clear") {
    const account = rest[1] || "acct_main";
    const snap = await deps.patchAccountRateLimit(cfg.baseUrl, cfg.authToken, account, {
      reset: true,
    });
    ui.notify(
      `Rate-limit override cleared for ${account}. Now:\n${formatRateLimitSnap(snap)}`,
      "info",
    );
    return;
  }

  // status [account]
  const account =
    action === "status" || action === "show" || action === "get"
      ? rest[1] || "acct_main"
      : rest[0] && !["status", "show", "get"].includes(action)
        ? rest[0]
        : "acct_main";
  const snap = await deps.getAccountRateLimit(cfg.baseUrl, cfg.authToken, account);
  ui.notify(formatRateLimitSnap(snap), "info");
}

function parseKvPairs(parts: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k) continue;
    if (v === "true") body[k] = true;
    else if (v === "false") body[k] = false;
    else if (/^-?\d+$/.test(v)) body[k] = Number(v);
    else body[k] = v;
  }
  return body;
}

function formatRateLimitSnap(snap: {
  account_id: string;
  enabled: boolean;
  mode: string;
  policy: Record<string, number>;
  state?: Record<string, unknown>;
}): string {
  const p = snap.policy ?? {};
  const st = snap.state ?? {};
  return [
    `Rate limit ${snap.account_id}: ${snap.enabled ? "ON" : "OFF"} mode=${snap.mode}`,
    `  gap=${p.min_submit_gap_ms ?? "?"}ms inflight_max=${p.max_inflight ?? "?"}`,
    `  rolling=${p.rolling_max_submits ?? "?"}/${Math.round((p.rolling_window_ms ?? 0) / 1000)}s`,
    `  cooldown=${st.cooldownUntil ?? st.cooldown_until ?? "none"} inflight=${st.inflight ?? 0} window_submits=${st.submitsInWindow ?? st.submits_in_window ?? 0}`,
  ].join("\n");
}

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof AifrostClientError) {
    // bodyText may contain server messages; never log tokens
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export { HELP_TEXT };
