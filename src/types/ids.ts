import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export type AgentId = `agt_${string}`;
export type GenerationId = `gen_${string}`;
export type EventId = `evt_${string}`;
export type MessageId = `msg_${string}`;
export type AccountId = `acct_${string}`;
export type RuntimeId = `rt_${string}`;

export function newAgentId(): AgentId {
  return `agt_${nano()}`;
}

export function newGenerationId(): GenerationId {
  return `gen_${nano()}`;
}

export function newEventId(): EventId {
  return `evt_${nano()}`;
}

export function newMessageId(): MessageId {
  return `msg_${nano()}`;
}

export function newAccountId(): AccountId {
  return `acct_${nano()}`;
}

export function newRuntimeId(): RuntimeId {
  return `rt_${nano()}`;
}

/**
 * account_id flows into filesystem paths (state/profiles/<id>/) and process
 * matching (pgrep). Restrict to a safe alphabet to prevent path traversal and
 * shell/command-injection downstream.
 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === "string" && ACCOUNT_ID_RE.test(id);
}
