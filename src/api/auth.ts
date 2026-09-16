import type { FastifyRequest } from "fastify";
import { err } from "../types/errors.js";
import { timingSafeEqual } from "node:crypto";

/** API auth mode for the control plane + OpenAI mounts. */
export type AuthMode = "none" | "bearer";

export interface AuthConfig {
  mode: AuthMode;
  /** Required when mode is bearer; ignored when none. */
  token: string;
}

/**
 * Resolve auth from env-like map.
 *
 * - `AIFROST_AUTH=none` → no Authorization required (local dev only)
 * - `AIFROST_AUTH=bearer` (default) → Bearer token required
 * - `AIFROST_AUTH_TOKEN` → shared secret (default `dev-token-change-me` in CLI)
 *
 * Aliases for none: `off`, `disabled`, `false`, `0`
 */
export function resolveAuthConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  defaults?: { token?: string },
): AuthConfig {
  const raw = (env.AIFROST_AUTH ?? "bearer").trim().toLowerCase();
  if (raw === "none" || raw === "off" || raw === "disabled" || raw === "false" || raw === "0") {
    return { mode: "none", token: "" };
  }
  const token = (env.AIFROST_AUTH_TOKEN ?? defaults?.token ?? "").trim();
  return { mode: "bearer", token };
}

export function requireBearer(req: FastifyRequest, expectedToken: string): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw err("unauthorized", "Missing bearer token", 401);
  }
  const token = header.slice("Bearer ".length).trim();
  if (!tokensEqual(token, expectedToken)) {
    throw err("unauthorized", "Invalid bearer token", 401);
  }
}

/**
 * Enforce auth according to config. No-op when mode is `none`.
 * When bearer and token is empty, reject (misconfiguration).
 */
export function enforceAuth(req: FastifyRequest, config: AuthConfig): void {
  if (config.mode === "none") return;
  if (!config.token) {
    throw err("unauthorized", "Server bearer auth enabled but AIFROST_AUTH_TOKEN is empty", 401);
  }
  requireBearer(req, config.token);
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** True for loopback bind addresses (safe for auth=none). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}
