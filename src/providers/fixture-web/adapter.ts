import type { ProviderPageContext, ProviderWebUIAdapter } from "../contract.js";
import type { ProviderCapabilities } from "../../types/capabilities.js";
import type { CanonicalGenerationEvent } from "../../types/events.js";
import type {
  CancelResult,
  CanonicalGenerationRequest,
  FinalReconciliation,
  ObservedAgentState,
  ProviderConversationRef,
  ProviderDetection,
} from "../../types/generation.js";
import type { NormalizedMessage } from "../../types/messages.js";
import { textContent } from "../../types/messages.js";
import type { SettingsApplyResult } from "../../types/settings.js";
import { diffSettings } from "../../types/settings.js";
import { newMessageId } from "../../types/ids.js";
import { extractPlainText } from "../../types/messages.js";
import { planHarnessToolIntents } from "../../protocols/openai/harness-tools.js";

/**
 * Deterministic fixture provider — first adapter to prove the control plane.
 * Uses PageBridge host commands against MockBrowserBackend (and Chromium when injected).
 */
export class FixtureWebAdapter implements ProviderWebUIAdapter {
  readonly id = "fixture-web";
  readonly version = "0.1.0";
  readonly hosts = ["fixture.local", "127.0.0.1"];

  async detect(ctx: ProviderPageContext): Promise<ProviderDetection> {
    const res = (await ctx.bridge.invoke({
      id: "detect",
      type: "provider.detect",
    })) as { accepted: boolean; result?: ProviderDetection };
    if (!res.accepted || !res.result) {
      return { providerId: this.id, matched: false };
    }
    return res.result;
  }

  async awaitReady(ctx: ProviderPageContext): Promise<void> {
    const state = await this.readState(ctx);
    if (!state.ready) {
      throw new Error("fixture provider not ready");
    }
  }

  async inspectCapabilities(_ctx: ProviderPageContext): Promise<ProviderCapabilities> {
    return {
      provider: this.id,
      adapterVersion: this.version,
      revision: "cap_fixture_1",
      observedAt: new Date().toISOString(),
      settingsSchema: {
        type: "object",
        properties: {
          model_or_mode: {
            type: "string",
            enum: ["fixture-default", "fixture-fast", "fixture-expert"],
          },
          reasoning: {
            type: "object",
            properties: {
              effort: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
      operations: {
        newConversation: true,
        openConversation: true,
        cancelGeneration: true,
        attachments: false,
        builtInSearch: "unsupported",
        artifacts: "unsupported",
      },
      protocolFidelity: {
        systemRole: "emulated",
        developerRole: "unsupported",
        // OpenAI tool_calls façade: emit intents when client sends tools[]
        arbitraryFunctionTools: "emulated",
        usageTokens: "unobservable",
      },
    };
  }

  async readState(ctx: ProviderPageContext): Promise<ObservedAgentState> {
    const res = (await ctx.bridge.invoke({
      id: "inspect",
      type: "agent.inspect",
    })) as { accepted: boolean; result: ObservedAgentState };
    return res.result;
  }

  async createConversation(ctx: ProviderPageContext): Promise<ProviderConversationRef> {
    const res = (await ctx.bridge.invoke({
      id: "new",
      type: "conversation.new",
    })) as { accepted: boolean; result: ProviderConversationRef };
    return res.result;
  }

  async openConversation(ctx: ProviderPageContext, ref: ProviderConversationRef): Promise<void> {
    await ctx.bridge.invoke({
      id: "open",
      type: "conversation.open",
      ref,
    });
  }

  async applySettings(
    ctx: ProviderPageContext,
    desired: Record<string, unknown>,
  ): Promise<SettingsApplyResult> {
    const res = (await ctx.bridge.invoke({
      id: "settings",
      type: "agent.apply_settings",
      settings: desired,
    })) as {
      accepted: boolean;
      result: {
        desired: Record<string, unknown>;
        effective: Record<string, unknown>;
        warnings: string[];
      };
    };
    const effective = res.result.effective;
    return {
      desired: res.result.desired,
      effective,
      revision: 0, // actor assigns revision
      warnings: res.result.warnings ?? [],
      mismatches: diffSettings(desired, effective),
    };
  }

  async *generate(
    ctx: ProviderPageContext,
    request: CanonicalGenerationRequest,
  ): AsyncIterable<CanonicalGenerationEvent> {
    const generationId = request.generationId;
    yield { type: "generation.created", generationId };
    yield { type: "generation.started", generationId };

    const inputText = request.newTurnMessages.map((m) => extractPlainText(m)).join("\n");

    // Harness-local tools façade (see AIFROST_HARNESS_TOOLS). Fixture defaults
    // to always emitting tool_calls when tools[] is present so CI/Pi can test
    // agentic loops without a live model.
    const toolIntents = planHarnessToolIntents({
      userText: inputText,
      tools: request.tools ?? [],
      // Fixture: prefer always unless user set never
      mode:
        process.env.AIFROST_HARNESS_TOOLS === "never" || process.env.AIFROST_HARNESS_TOOLS === "0"
          ? "never"
          : process.env.AIFROST_HARNESS_TOOLS === "auto"
            ? "auto"
            : "always",
    });
    if (toolIntents && toolIntents.length > 0) {
      yield {
        type: "generation.completed",
        generationId,
        messages: [],
        usage: null,
        toolIntents,
      };
      return;
    }

    await ctx.bridge.invoke({
      id: "start",
      type: "generation.start",
      generationId,
      inputText,
    });

    let assembled = "";
    let done = false;
    let cancelled = false;
    let lastSeq = 0;
    // Bound the pump loop — a broken page bridge must fail, not spin forever.
    const deadline = Date.now() + 60_000;

    while (!done) {
      if (Date.now() > deadline) {
        yield {
          type: "generation.failed",
          generationId,
          error: {
            code: "provider_output_invalid",
            message: "fixture generation timed out waiting for completion",
            retryable: false,
          },
        };
        return;
      }
      // Pump fixture stream one token per loop (deterministic)
      const pump = (await ctx.bridge.invoke({
        id: "pump",
        type: "generation.pump",
      })) as {
        accepted: boolean;
        result?: { done?: boolean; cancelled?: boolean; token?: string };
      };

      const drained = await ctx.bridge.drain(lastSeq, 50);
      if (drained.overflow) {
        yield {
          type: "generation.failed",
          generationId,
          error: {
            code: "provider_output_invalid",
            message: "page bridge event buffer overflow",
            retryable: false,
          },
        };
        return;
      }
      for (const ev of drained.events) {
        lastSeq = Math.max(lastSeq, ev.seq);
        const payload = ev.payload as Record<string, unknown>;
        if (ev.type === "generation.text.delta") {
          const delta = String(payload.text ?? "");
          assembled += delta;
          yield { type: "output_text.delta", generationId, delta };
        } else if (ev.type === "generation.cancelled") {
          cancelled = true;
          done = true;
        } else if (ev.type === "generation.completed") {
          assembled = String(payload.text ?? assembled);
          done = true;
        }
      }
      await ctx.bridge.acknowledge(lastSeq);

      if (pump.result?.cancelled) {
        cancelled = true;
        done = true;
      }
      if (pump.result?.done) {
        done = true;
        if (pump.result.cancelled) cancelled = true;
      }
    }

    if (cancelled) {
      yield { type: "generation.cancelled", generationId };
      return;
    }

    const message: NormalizedMessage = {
      id: newMessageId(),
      agentId: request.agentId,
      providerMessageId: `fix_${generationId}`,
      role: "assistant",
      content: [textContent(assembled)],
      createdAt: new Date().toISOString(),
      metadata: { provider: this.id },
    };

    yield {
      type: "generation.completed",
      generationId,
      messages: [message],
      usage: null,
    };
  }

  async cancel(ctx: ProviderPageContext, generationId: string): Promise<CancelResult> {
    // Signal only — the active generate() loop owns pumping/drain so we avoid races.
    await ctx.bridge.invoke({
      id: "cancel",
      type: "generation.cancel",
      generationId,
    });
    return {
      accepted: true,
      confirmedIdle: false,
      detail: "cancel signaled; await generate terminal event",
    };
  }

  async readHistory(ctx: ProviderPageContext): Promise<NormalizedMessage[]> {
    const res = (await ctx.bridge.invoke({
      id: "hist",
      type: "history.snapshot",
    })) as {
      accepted: boolean;
      result: { messages: Array<{ id: string; role: string; text: string }> };
    };
    return res.result.messages.map((m) => ({
      id: newMessageId(),
      agentId: ctx.agentId,
      providerMessageId: m.id,
      role: m.role as NormalizedMessage["role"],
      content: [textContent(m.text)],
      createdAt: new Date().toISOString(),
      metadata: {},
    }));
  }

  async reconcileFinal(
    ctx: ProviderPageContext,
    generationId: string,
  ): Promise<FinalReconciliation> {
    const history = await this.readHistory(ctx);
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    return {
      generationId: generationId as FinalReconciliation["generationId"],
      messages: lastAssistant ? [lastAssistant] : [],
      matchedStream: true,
      warnings: lastAssistant ? [] : ["no assistant message found for reconciliation"],
    };
  }
}
