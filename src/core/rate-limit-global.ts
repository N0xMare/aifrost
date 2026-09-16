/**
 * Process-wide ChatGPT rate limiter (set from cli serve).
 * Adapter submitPrompt uses this so every WebUI send is paced/counted.
 */
import type { AccountRateLimitController } from "./account-rate-limit.js";

let active: AccountRateLimitController | null = null;

export function setActiveRateLimiter(controller: AccountRateLimitController | null): void {
  active = controller;
}

export function getActiveRateLimiter(): AccountRateLimitController | null {
  return active;
}
