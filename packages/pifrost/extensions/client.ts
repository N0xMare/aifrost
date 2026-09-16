/**
 * Aifrost HTTP client — pure fetch helpers (no Pi imports).
 */

import { normalizeBaseUrl } from "./config.js";

/** Default request timeout so a hung control plane cannot stall Pi forever. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Minimal agent shape returned by GET /v1/agents. */
export interface AifrostAgent {
  id: string;
  object?: string;
  provider: string;
  account_id: string;
  lifecycle: string;
  activity?: string;
  auth?: string;
  revision?: number;
  metadata?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface CreateAgentBody {
  provider: string;
  account_id?: string;
  conversation?: {
    mode: "new" | "open";
    provider_conversation_id?: string;
  };
  settings?: Record<string, unknown>;
  metadata?: Record<string, string>;
}

export class AifrostClientError extends Error {
  readonly status?: number;
  readonly bodyText?: string;

  constructor(message: string, status?: number, bodyText?: string) {
    super(message);
    this.name = "AifrostClientError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function jsonHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function fetchInit(init: RequestInit, timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): RequestInit {
  // Node 22+ / modern undici: AbortSignal.timeout aborts on wall clock.
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return { ...init, signal: AbortSignal.timeout(timeoutMs) };
  }
  return init;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    // Avoid dumping huge or secret-looking payloads into errors
    if (text.length > 500) return `${text.slice(0, 500)}…`;
    return text;
  } catch {
    return "";
  }
}

/** Prefer JSON error.message when present; otherwise truncated body. */
function formatHttpError(prefix: string, status: number, bodyText: string): string {
  let core: string;
  if (!bodyText) {
    core = `${prefix}: HTTP ${status}`;
  } else {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: string; code?: string };
        message?: string;
      };
      const msg =
        parsed.error?.message ?? (typeof parsed.message === "string" ? parsed.message : undefined);
      const code = parsed.error?.code;
      if (msg && code) core = `${prefix}: HTTP ${status} (${code}) ${msg}`;
      else if (msg) core = `${prefix}: HTTP ${status} ${msg}`;
      else core = `${prefix}: HTTP ${status}: ${bodyText}`;
    } catch {
      core = `${prefix}: HTTP ${status}: ${bodyText}`;
    }
  }
  if (status === 401) {
    return (
      `${core} — auth mismatch: set AIFROST_AUTH_TOKEN to match the server, ` +
      `or use AIFROST_AUTH=none on both Aifrost and Pi for local loopback.`
    );
  }
  return core;
}

/**
 * GET /healthz — does not require auth on Aifrost.
 * Token is accepted for API symmetry and ignored by the server.
 */
export async function healthCheck(baseUrl: string, _token?: string): Promise<{ ok: boolean }> {
  const url = `${normalizeBaseUrl(baseUrl)}/healthz`;
  let res: Response;
  try {
    res = await fetch(url, fetchInit({ method: "GET", headers: { Accept: "application/json" } }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Aifrost health check failed: ${msg}`);
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Aifrost health check failed", res.status, body),
      res.status,
      body,
    );
  }
  const data = (await res.json()) as { ok?: boolean };
  return { ok: data.ok === true };
}

/**
 * GET /v1/agents — list agents (requires bearer token).
 */
export async function listAgents(baseUrl: string, token: string): Promise<AifrostAgent[]> {
  // Empty token is allowed when server runs with AIFROST_AUTH=none.
  const url = `${normalizeBaseUrl(baseUrl)}/v1/agents`;
  let res: Response;
  try {
    res = await fetch(url, fetchInit({ method: "GET", headers: jsonHeaders(token) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to list agents: ${msg}`);
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to list agents", res.status, body),
      res.status,
      body,
    );
  }
  const payload = (await res.json()) as {
    object?: string;
    data?: AifrostAgent[];
  };
  if (!Array.isArray(payload.data)) {
    throw new AifrostClientError("Unexpected list agents response: missing data[]");
  }
  return payload.data;
}

/**
 * DELETE /v1/agents/:id — soft-delete agent (204).
 */
export async function deleteAgent(baseUrl: string, token: string, agentId: string): Promise<void> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/agents/${encodeURIComponent(agentId)}`;
  let res: Response;
  try {
    res = await fetch(url, fetchInit({ method: "DELETE", headers: jsonHeaders(token) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to delete agent: ${msg}`);
  }
  if (!res.ok && res.status !== 204) {
    const body = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to delete agent", res.status, body),
      res.status,
      body,
    );
  }
}

/**
 * POST /v1/agents — create an agent (requires bearer token).
 */
export async function createAgent(
  baseUrl: string,
  token: string,
  body: CreateAgentBody,
): Promise<AifrostAgent> {
  // Empty token is allowed when server runs with AIFROST_AUTH=none.
  const url = `${normalizeBaseUrl(baseUrl)}/v1/agents`;
  let res: Response;
  try {
    res = await fetch(
      url,
      fetchInit({
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to create agent: ${msg}`);
  }
  if (!res.ok) {
    const errBody = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to create agent", res.status, errBody),
      res.status,
      errBody,
    );
  }
  return (await res.json()) as AifrostAgent;
}

export interface AccountRateLimitSnapshot {
  account_id: string;
  enabled: boolean;
  mode: string;
  policy: Record<string, number>;
  defaults?: Record<string, unknown>;
  override?: Record<string, unknown> | null;
  state?: Record<string, unknown>;
}

export async function getGlobalRateLimit(
  baseUrl: string,
  token: string,
): Promise<Record<string, unknown>> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/rate-limit`;
  let res: Response;
  try {
    res = await fetch(url, fetchInit({ method: "GET", headers: jsonHeaders(token) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to get rate-limit defaults: ${msg}`);
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to get rate-limit defaults", res.status, body),
      res.status,
      body,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function getAccountRateLimit(
  baseUrl: string,
  token: string,
  accountId: string,
): Promise<AccountRateLimitSnapshot> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/accounts/${encodeURIComponent(accountId)}/rate-limit`;
  let res: Response;
  try {
    res = await fetch(url, fetchInit({ method: "GET", headers: jsonHeaders(token) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to get account rate-limit: ${msg}`);
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to get account rate-limit", res.status, body),
      res.status,
      body,
    );
  }
  return (await res.json()) as AccountRateLimitSnapshot;
}

export async function patchAccountRateLimit(
  baseUrl: string,
  token: string,
  accountId: string,
  body: Record<string, unknown>,
): Promise<AccountRateLimitSnapshot> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/accounts/${encodeURIComponent(accountId)}/rate-limit`;
  let res: Response;
  try {
    res = await fetch(
      url,
      fetchInit({
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AifrostClientError(`Failed to patch account rate-limit: ${msg}`);
  }
  if (!res.ok) {
    const errBody = await readErrorBody(res);
    throw new AifrostClientError(
      formatHttpError("Failed to patch account rate-limit", res.status, errBody),
      res.status,
      errBody,
    );
  }
  return (await res.json()) as AccountRateLimitSnapshot;
}
