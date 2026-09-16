import type { AgentId, MessageId } from "./ids.js";

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "image"; source: unknown }
  | { type: "document"; source: unknown }
  | { type: "citation"; citation: unknown }
  | { type: "tool_call"; call: unknown }
  | { type: "tool_result"; result: unknown }
  | { type: "artifact"; artifact: unknown }
  | { type: "provider_extension"; provider: string; data: unknown };

export interface NormalizedMessage {
  id: MessageId;
  agentId: AgentId;
  providerMessageId: string | null;
  role: MessageRole;
  content: NormalizedContentPart[];
  createdAt: string | null;
  metadata: Record<string, unknown>;
}

export type InputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; source: unknown }
  | { type: "input_document"; source: unknown };

export function textContent(text: string): NormalizedContentPart {
  return { type: "text", text };
}

export function extractPlainText(message: NormalizedMessage): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
