/**
 * Env / config resolution for pifrost.
 * Pure helpers — no Pi imports.
 */

export type AifrostApi = "openai-completions" | "openai-responses";

export interface AifrostConfig {
  /** Normalized base URL without trailing slash. */
  baseUrl: string;
  /** Bearer token for Aifrost API. May be empty when server uses AIFROST_AUTH=none. */
  authToken: string;
  /**
   * When true, send Authorization on inference (Pi authHeader).
   * False when no token (local no-auth server).
   */
  authHeader: boolean;
  /** Optional agent id to prefer when ordering models. */
  defaultAgent?: string;
  /** OpenAI-compatible API dialect for Pi. */
  api: AifrostApi;
  /**
   * Which providers appear in /model.
   * - `all` — fixture + chatgpt (default when AIFROST_SHOW_FIXTURE=1)
   * - `chatgpt` — only chatgpt-web (default for harness use)
   * - `fixture` — only fixture-web
   */
  modelFilter: "all" | "chatgpt" | "fixture";
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_API: AifrostApi = "openai-completions";

/** Strip trailing slashes from a base URL. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Resolve Aifrost configuration from an env-like object (defaults to process.env).
 *
 * - `AIFROST_URL` default `http://127.0.0.1:8787`
 * - `AIFROST_AUTH_TOKEN` may be empty at load (models empty + notify)
 * - `AIFROST_DEFAULT_AGENT` optional preferred agent id
 * - `AIFROST_API` = `openai-completions` | `openai-responses` (default completions)
 * - `AIFROST_MODELS` = `chatgpt` | `fixture` | `all` (default chatgpt — hide Echo stubs)
 * - `AIFROST_SHOW_FIXTURE=1` forces fixture models visible (alias for all)
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AifrostConfig {
  const baseUrl = normalizeBaseUrl(env.AIFROST_URL ?? DEFAULT_BASE_URL);
  const authToken = (env.AIFROST_AUTH_TOKEN ?? "").trim();
  // Explicit AIFROST_AUTH=none on the Pi side disables bearer even if a token is set.
  const authMode = (env.AIFROST_AUTH ?? "bearer").trim().toLowerCase();
  const authDisabled =
    authMode === "none" ||
    authMode === "off" ||
    authMode === "disabled" ||
    authMode === "false" ||
    authMode === "0";
  const authHeader = !authDisabled && authToken.length > 0;
  const defaultRaw = env.AIFROST_DEFAULT_AGENT?.trim();
  const defaultAgent = defaultRaw ? defaultRaw : undefined;
  const api = parseApi(env.AIFROST_API);
  const modelFilter = parseModelFilter(env);

  return {
    baseUrl,
    authToken: authDisabled ? "" : authToken,
    authHeader,
    defaultAgent,
    api,
    modelFilter,
  };
}

function parseModelFilter(env: Record<string, string | undefined>): AifrostConfig["modelFilter"] {
  if (env.AIFROST_SHOW_FIXTURE === "1" || env.AIFROST_SHOW_FIXTURE === "true") {
    return "all";
  }
  const raw = (env.AIFROST_MODELS ?? "chatgpt").trim().toLowerCase();
  if (raw === "all" || raw === "fixture" || raw === "chatgpt") return raw;
  return "chatgpt";
}

function parseApi(raw: string | undefined): AifrostApi {
  const v = raw?.trim();
  if (v === "openai-responses" || v === "openai-completions") {
    return v;
  }
  return DEFAULT_API;
}

/** True when a non-empty auth token is configured. */
export function hasAuthToken(config: AifrostConfig): boolean {
  return config.authToken.length > 0;
}
