/**
 * ChatGPT Web (chatgpt.com) — first production provider.
 *
 * Runtime: Chromium/Brave via BrowserSession + PageBridgeHost.
 * Live generation requires an authenticated profile (login doctor).
 */

import type { ProviderPageContext, ProviderWebUIAdapter } from "../contract.js";
import type { ProviderCapabilities } from "../../types/capabilities.js";
import type { CanonicalGenerationEvent } from "../../types/events.js";
import type {
  CancelResult,
  CanonicalGenerationRequest,
  CanonicalToolIntent,
  FinalReconciliation,
  ObservedAgentState,
  ProviderConversationRef,
  ProviderDetection,
} from "../../types/generation.js";
import type { NormalizedMessage } from "../../types/messages.js";
import { extractPlainText, textContent } from "../../types/messages.js";
import type { SettingsApplyResult } from "../../types/settings.js";
import { diffSettings } from "../../types/settings.js";
import { newMessageId, type GenerationId } from "../../types/ids.js";
import {
  buildIncompleteToolScaffoldNudge,
  looksLikeIncompleteToolScaffold,
  needsToolScaffoldRecovery,
  parseHostToolIntents,
  wrapUserTextForHarnessTools,
} from "../../protocols/openai/tool-intents.js";
import { getActiveRateLimiter } from "../../core/rate-limit-global.js";
import {
  buildHostOnlyCorrectiveNudge,
  looksLikeAifrostToolRefusal,
  looksLikeChatGptProductSandbox,
  looksLikeProseOnlyRequest,
  looksLikeStrongProductSandbox,
  stripHarnessPeEcho,
  userLikelyNeedsHostTools,
} from "../../protocols/openai/harness-protocol.js";
import {
  looksLikeChatGptLayerARateLimit,
  looksLikeChatGptLayerCRateLimit,
} from "../../core/account-rate-limit.js";
import { logger } from "../../observability/logger.js";
import {
  ensureChatGptProject,
  openNewChatInProject,
  resolveChatGptProjectName,
} from "./projects.js";
import { captureDumpDir, dumpGenerationCapture } from "./capture-dump.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";

/**
 * Page-side composer selectors. ChatGPT's composer DOM drifts (ProseMirror
 * contenteditable, aria-labels instead of stable data-testids), so every probe
 * scopes to the composer's <form> and falls back to aria-labels.
 */
const COMPOSER_ROOT_JS = `(document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea'))`;

const STOP_BUTTON_EXPR = `(function(){
  if (document.querySelector('button[data-testid="stop-button"]')) return true;
  const root = ${COMPOSER_ROOT_JS};
  const form = root && root.closest('form');
  if (!form) return false;
  return Array.from(form.querySelectorAll('button')).some(function(b){
    return /stop/i.test(b.getAttribute('aria-label') || '');
  });
})()`;

const SEND_READY_EXPR = `(function(){
  const direct = document.querySelector('button[data-testid="send-button"]:not([disabled]), button[data-testid="composer-send-button"]:not([disabled])');
  if (direct) return true;
  const root = ${COMPOSER_ROOT_JS};
  const form = root && root.closest('form');
  if (!form) return false;
  const b = Array.from(form.querySelectorAll('button')).find(function(x){
    return /^send\\b/i.test((x.getAttribute('aria-label') || '').trim());
  });
  return !!b && !b.disabled;
})()`;

export class ChatGptWebAdapter implements ProviderWebUIAdapter {
  readonly id = "chatgpt-web";
  readonly version = "0.1.0-alpha";
  readonly hosts = ["chatgpt.com", "chat.openai.com"];

  /** Generations cancel() was invoked for — generate() maps these to
   *  generation.cancelled instead of reporting a partial capture as success. */
  private readonly cancelledGenerations = new Set<string>();

  async detect(ctx: ProviderPageContext): Promise<ProviderDetection> {
    const href = await evalString(ctx, "location.href");
    const title = await evalString(ctx, "document.title");
    const host = await evalString(ctx, "location.hostname");
    const matched =
      host.includes("chatgpt.com") ||
      host.includes("chat.openai.com") ||
      href.includes("chatgpt.com");
    const challenge = /just a moment/i.test(title);
    return {
      providerId: this.id,
      matched: matched && !challenge,
      buildFingerprint: await this.fingerprint(ctx),
      detail: challenge
        ? "cloudflare_challenge"
        : matched
          ? "chatgpt_host"
          : `unexpected_host:${host}`,
    };
  }

  async awaitReady(ctx: ProviderPageContext): Promise<void> {
    // Navigate if not already on ChatGPT
    let href = await evalString(ctx, "location.href");
    if (!href.includes("chatgpt.com") && !href.includes("chat.openai.com")) {
      await ctx.session.navigate(CHATGPT_ORIGIN + "/");
      await sleep(1_500);
      href = await evalString(ctx, "location.href");
    }

    // Mock backends cannot load real ChatGPT — exit quickly
    if (
      !href.includes("chatgpt.com") &&
      !href.includes("chat.openai.com") &&
      !href.startsWith("https://")
    ) {
      return;
    }

    // Wait up to ~20s for title/body to settle (CF or SPA boot)
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const title = await evalString(ctx, "document.title");
      const ready = await evalString(ctx, "document.readyState");
      if (ready === "complete" && title && !/just a moment/i.test(title)) {
        return;
      }
      if (/just a moment/i.test(title)) {
        await sleep(800);
        continue;
      }
      await sleep(400);
    }
    // Not fatal — create path will set auth from readState
  }

  async inspectCapabilities(ctx: ProviderPageContext): Promise<ProviderCapabilities> {
    const state = await this.readState(ctx).catch(() => null);
    return {
      provider: this.id,
      adapterVersion: this.version,
      revision: "cap_chatgpt_alpha_1",
      observedAt: new Date().toISOString(),
      settingsSchema: {
        type: "object",
        properties: {
          model_or_mode: { type: "string", description: "UI model label when observable" },
        },
      },
      operations: {
        newConversation: true,
        openConversation: true,
        cancelGeneration: true,
        attachments: "unknown",
        builtInSearch: "unknown",
        artifacts: "unknown",
      },
      protocolFidelity: {
        systemRole: "emulated",
        developerRole: "unsupported",
        arbitraryFunctionTools: "emulated",
        usageTokens: "unobservable",
      },
      extensions: {
        auth: state?.auth ?? "unknown",
        runtime: "chromium_brave",
      },
    };
  }

  async readState(ctx: ProviderPageContext): Promise<ObservedAgentState> {
    const title = await evalString(ctx, "document.title");
    const href = await evalString(ctx, "location.href");
    const challenge = /just a moment/i.test(title);

    const hasComposer = await evalBool(
      ctx,
      `!!(document.querySelector('#prompt-textarea') || document.querySelector('[data-testid="composer"]') || document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea'))`,
    );

    const loginHints = await evalBool(
      ctx,
      `!!(document.querySelector('button[data-testid="login-button"]') || document.body?.innerText?.match(/Log in|Sign up|Welcome to ChatGPT/i))`,
    );

    let auth: ObservedAgentState["auth"] = "unknown";
    if (challenge) auth = "unknown";
    else if (hasComposer) auth = "authenticated";
    else if (loginHints) auth = "login_required";
    else auth = "unknown";

    const convId = extractConversationId(href);

    return {
      auth,
      ready: hasComposer && !challenge,
      conversation: {
        providerConversationId: convId ?? undefined,
        providerUrl: href.startsWith("http") ? href : undefined,
        title: title || undefined,
        turnCount: 0,
      },
      settings: {},
      providerBuildFingerprint: await this.fingerprint(ctx),
    };
  }

  async createConversation(ctx: ProviderPageContext): Promise<ProviderConversationRef> {
    await this.ensureOnChatgpt(ctx);

    const projectName = resolveChatGptProjectName();
    if (projectName) {
      try {
        const project = await ensureChatGptProject(ctx, projectName);
        const opened = await openNewChatInProject(ctx, project);
        // Project home has a composer; first generate creates an in-project chat.
        // Do NOT click global sidebar "New chat" (href=/) — that leaves the project.
        return {
          providerConversationId: extractConversationId(opened.providerUrl) ?? undefined,
          providerUrl: opened.providerUrl,
        };
      } catch (e) {
        // Fall through to top-level new chat — surfaced in logs, not just the page.
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(
          { err: msg, accountId: ctx.accountId, project: projectName },
          "chatgpt-web: project bootstrap failed; using top-level chat",
        );
      }
    }

    // Top-level new chat (AIFROST_CHATGPT_PROJECT=none or project ensure failed)
    await ctx.session.navigate(`${CHATGPT_ORIGIN}/`);
    await sleep(1_500);
    await ctx.session.evaluate(`
      (function(){
        const candidates = Array.from(document.querySelectorAll('a,button'));
        const el = candidates.find(e =>
          /new chat/i.test(e.textContent||'')
          || e.getAttribute('aria-label')?.match(/new chat/i)
          || e.getAttribute('data-testid') === 'create-new-chat-button'
        );
        if (el) el.click();
        return !!el;
      })()
    `);
    await sleep(1_000);

    const href = await evalString(ctx, "location.href");
    return {
      providerConversationId: extractConversationId(href) ?? undefined,
      providerUrl: href,
    };
  }

  async openConversation(ctx: ProviderPageContext, ref: ProviderConversationRef): Promise<void> {
    const id = ref.providerConversationId;
    // Project chats have /g/g-p-<id>-<slug>/c/<conv> URLs (valid; only the
    // /g/…/project home form redirects to /). Plain /c/<id> also works.
    const url = ref.providerUrl ?? (id ? `${CHATGPT_ORIGIN}/c/${id}` : CHATGPT_ORIGIN + "/");

    await ctx.session.navigate(url);
    await sleep(2_000);
  }

  async applySettings(
    ctx: ProviderPageContext,
    desired: Record<string, unknown>,
  ): Promise<SettingsApplyResult> {
    // v1 alpha: store desired only; UI model switching is provider-drift-sensitive
    const state = await this.readState(ctx);
    const effective = { ...state.settings, ...desired };
    const mismatches = diffSettings(desired, effective);
    return {
      desired: { ...desired },
      effective,
      revision: 0,
      warnings: [
        "chatgpt-web settings apply is best-effort; model UI mutation not fully automated in alpha",
      ],
      mismatches,
    };
  }

  async *generate(
    ctx: ProviderPageContext,
    request: CanonicalGenerationRequest,
  ): AsyncIterable<CanonicalGenerationEvent> {
    const generationId = request.generationId;
    yield { type: "generation.created", generationId };
    yield { type: "generation.started", generationId };

    const state = await this.readState(ctx);
    if (state.auth === "login_required" || !state.ready) {
      yield {
        type: "generation.failed",
        generationId,
        error: {
          code: "auth_expired",
          message:
            state.auth === "login_required"
              ? "ChatGPT login required. Run: npx tsx scripts/chatgpt-login.ts --account " +
                ctx.accountId
              : "ChatGPT page not ready (Cloudflare challenge or composer missing).",
          retryable: false,
          providerId: this.id,
          agentId: request.agentId,
          generationId,
        },
      };
      return;
    }

    const inputText = request.newTurnMessages.map((m) => extractPlainText(m)).join("\n");
    if (!inputText.trim()) {
      yield {
        type: "generation.failed",
        generationId,
        error: {
          code: "invalid_request",
          message: "Empty user input",
          retryable: false,
          generationId,
        },
      };
      return;
    }

    // Host tools: ask ChatGPT (via WebUI) to emit AIFROST_TOOL blocks when needed.
    // We never hardcode bash/ls — the model chooses tools; Pi executes on the laptop.
    const clientTools = request.tools ?? [];
    const lastUserText = inputText.trim();
    const proseOnly = looksLikeProseOnlyRequest(lastUserText);
    const webInput = capWebUiSubmitText(
      clientTools.length > 0 ? wrapUserTextForHarnessTools(inputText, clientTools) : inputText,
    );

    // Install stream sniffer (activeGenId so multi-turn / corrective retries work)
    await this.armStreamCapture(ctx, generationId);

    try {
      yield* this.generateArmed(ctx, request, {
        clientTools,
        lastUserText,
        proseOnly,
        webInput,
      });
    } finally {
      this.cancelledGenerations.delete(generationId);
      await this.dumpCapture(ctx, request.agentId, generationId);
      await this.clearStreamCapture(ctx, generationId);
    }
  }

  /**
   * Best-effort debug dump of the page-side capture buffer before
   * clearStreamCapture deletes it. No-op unless AIFROST_CAPTURE_DIR is set.
   */
  private async dumpCapture(
    ctx: ProviderPageContext,
    agentId: string,
    generationId: string,
  ): Promise<void> {
    if (!captureDumpDir()) return;
    try {
      const snap = await ctx.session.evaluate(`
        (function(genId){
          const st = window.__AIFROST_CHATGPT__;
          if (!st) return null;
          return {
            text: st.buffers[genId] || '',
            error: st.errors[genId] || null,
            url: location.href,
          };
        })(${JSON.stringify(generationId)})
      `);
      const payload = snap?.value as {
        text?: string;
        error?: string | null;
        url?: string;
      } | null;
      await dumpGenerationCapture({
        agentId,
        generationId,
        url: payload?.url,
        rawNetworkText: payload?.text ?? "",
        pageError: payload?.error ?? null,
      });
    } catch {
      // Debug-only path — never fail a generation over a dump.
    }
  }

  /**
   * Body of generate() once the page capture is armed. The finally in
   * generate() guarantees per-generation page buffers are always cleaned up.
   */
  private async *generateArmed(
    ctx: ProviderPageContext,
    request: CanonicalGenerationRequest,
    pre: {
      clientTools: CanonicalGenerationRequest["tools"];
      lastUserText: string;
      proseOnly: boolean;
      webInput: string;
    },
  ): AsyncIterable<CanonicalGenerationEvent> {
    const generationId = request.generationId;
    const { clientTools, lastUserText, proseOnly, webInput } = pre;

    const userCountBefore = await countUserMessages(ctx);
    // Snapshot last assistant BEFORE submit — never treat prior turns as this reply
    // (was causing hello? → STOP after a previous sandbox message in the DOM).
    const baselineAssistant = (await readAssistantDom(ctx, lastUserText)).trim();

    // Strip both the original user text and the PE-wrapped WebUI payload
    // (DOM/network capture often glues the submitted user bubble into assistant).
    const echoTexts = [lastUserText, webInput.trim()].filter(
      (t, i, arr) => t && arr.indexOf(t) === i,
    );

    const submitted = await this.submitPrompt(ctx, webInput);
    if (!submitted.ok) {
      yield {
        type: "generation.failed",
        generationId,
        error: {
          code: "provider_output_invalid",
          message: submitted.error ?? "Failed to submit prompt to ChatGPT UI",
          retryable: true,
          generationId,
        },
      };
      return;
    }

    // Wait until our user message is visible (submit accepted)
    {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const n = await countUserMessages(ctx);
        if (n > userCountBefore) break;
        await sleep(200);
      }
    }

    // Collect capture WITHOUT streaming intermediate deltas (Pi concatenates chunks).
    let emitted = await this.collectAssistantText(ctx, {
      generationId,
      lastUserText,
      echoTexts,
      expectTools: clientTools.length > 0 && !proseOnly,
      baselineAssistant,
      maxWaitMs: proseOnly ? 45_000 : 180_000,
    });

    // Cancel clicked stop mid-generation — report cancelled, never a
    // partial capture as a successful completion.
    if (this.cancelledGenerations.has(generationId)) {
      yield { type: "generation.cancelled", generationId };
      return;
    }

    const pageBanner = await readRateLimitBanner(ctx);
    const rateText = `${emitted}\n${pageBanner}`;
    if (looksLikeChatGptLayerARateLimit(rateText) || looksLikeChatGptLayerCRateLimit(rateText)) {
      yield {
        type: "generation.failed",
        generationId,
        error: {
          code: "rate_limited",
          message:
            "ChatGPT temporarily limited conversation access (requests too quickly). " +
            "Aifrost will cool this account. Wait before retrying.",
          retryable: true,
          generationId,
        },
      };
      return;
    }

    if (!isUsefulAssistantText(emitted, lastUserText) && !emitted.includes("AIFROST_TOOL")) {
      yield {
        type: "generation.failed",
        generationId,
        error: {
          code: "provider_output_invalid",
          message: "No assistant text captured from network or DOM",
          retryable: true,
          generationId,
        },
      };
      return;
    }

    // Model requested host tools via PE scaffold → OpenAI tool_calls for Pi
    // Skip host-tool enforcement entirely on prose-only turns (hello / exact line).
    if (clientTools.length > 0 && !proseOnly) {
      let toolIntents = parseHostToolIntents(emitted);
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
      if (needsToolScaffoldRecovery(emitted)) {
        if (this.cancelledGenerations.has(generationId)) {
          yield { type: "generation.cancelled", generationId };
          return;
        }
        const recovered = await this.recoverIncompleteToolScaffold(ctx, {
          generationId,
          lastUserText,
          webInput,
          clientTools,
          echoTexts,
        });
        if (recovered && recovered.length > 0) {
          yield {
            type: "generation.completed",
            generationId,
            messages: [],
            usage: null,
            toolIntents: recovered,
          };
          return;
        }
        yield incompleteToolFail(generationId);
        return;
      }

      // Model explicitly refuses AIFROST_TOOL — fail fast (no second 180s hang)
      if (looksLikeAifrostToolRefusal(emitted)) {
        yield {
          type: "generation.failed",
          generationId,
          error: {
            code: "provider_output_invalid",
            message:
              "ChatGPT refused to emit AIFROST_TOOL (treats host protocol as unavailable). " +
              "Retry, or disable product agent/code-interpreter features.",
            retryable: true,
            generationId,
          },
        };
        return;
      }

      // Product sandbox / agent-mode: model ignored host PE. One corrective re-submit.
      // Never use needsHost on [tool_result] continues (false positives on paths/.js
      // caused STOP-nudge + bash loops after successful host tools).
      // On tool_result continues, only strong product markers trigger correctives —
      // final prose may restate ".dockerenv" / host probe words without being a sandbox.
      const isToolObsTurn = lastUserText.includes("[tool_result");
      const sandbox = isToolObsTurn
        ? looksLikeStrongProductSandbox(emitted)
        : looksLikeChatGptProductSandbox(emitted);
      const needsHost = !isToolObsTurn && userLikelyNeedsHostTools(lastUserText);
      if (sandbox || needsHost) {
        if (this.cancelledGenerations.has(generationId)) {
          yield { type: "generation.cancelled", generationId };
          return;
        }
        const nudge = capWebUiSubmitText(buildHostOnlyCorrectiveNudge(lastUserText, clientTools));
        const retryGenId = `${generationId}-hostfix`;
        await this.armStreamCapture(ctx, retryGenId);
        const userCountRetry = await countUserMessages(ctx);
        const retrySubmit = await this.submitPrompt(ctx, nudge);
        if (retrySubmit.ok) {
          {
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
              const n = await countUserMessages(ctx);
              if (n > userCountRetry) break;
              await sleep(200);
            }
          }
          // Do NOT put full corrective nudge in echoTexts — it contains example
          // AIFROST_TOOL blocks and can corrupt capture / parse of the real reply.
          const baselineAfterNudge = (await readAssistantDom(ctx, lastUserText)).trim();
          const cleaned = await this.collectAssistantText(ctx, {
            generationId: retryGenId,
            lastUserText,
            echoTexts: [lastUserText, webInput],
            expectTools: true,
            baselineAssistant: baselineAfterNudge,
            maxWaitMs: 60_000,
          });
          toolIntents = parseHostToolIntents(cleaned);
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
          if (looksLikeAifrostToolRefusal(cleaned)) {
            yield {
              type: "generation.failed",
              generationId,
              error: {
                code: "provider_output_invalid",
                message:
                  "ChatGPT refused AIFROST_TOOL after corrective retry (host protocol unavailable to the model). " +
                  "Disable product agent/code interpreter if on; open a fresh agent.",
                retryable: true,
                generationId,
              },
            };
            return;
          }
          // Host tool marker present but unparsed — not a sandbox; surface parse issue
          if (/AIFROST_TOOL/i.test(cleaned)) {
            yield {
              type: "generation.failed",
              generationId,
              error: {
                code: "provider_output_invalid",
                message:
                  "ChatGPT emitted AIFROST_TOOL after corrective retry but JSON could not be parsed. Retry the turn.",
                retryable: true,
                generationId,
              },
            };
            return;
          }
          const cleanedSandbox = isToolObsTurn
            ? looksLikeStrongProductSandbox(cleaned)
            : looksLikeChatGptProductSandbox(cleaned);
          if (cleanedSandbox) {
            yield {
              type: "generation.failed",
              generationId,
              error: {
                code: "provider_output_invalid",
                message:
                  "ChatGPT used product/sandbox tools instead of AIFROST_TOOL host protocol (after corrective retry). " +
                  "Turn off ChatGPT agent/code interpreter if enabled, then retry.",
                retryable: true,
                generationId,
              },
            };
            return;
          }
          // Tool-continue corrective: useful final prose is success (not more tools)
          if (cleaned.trim()) {
            emitted = cleaned;
          } else if (sandbox) {
            // Empty capture after corrective — do not claim sandbox if model may have
            // answered with host tools we failed to capture.
            yield {
              type: "generation.failed",
              generationId,
              error: {
                code: "provider_output_invalid",
                message:
                  "No assistant text captured after host-only corrective retry. Retry the turn.",
                retryable: true,
                generationId,
              },
            };
            return;
          }
        } else if (sandbox) {
          yield {
            type: "generation.failed",
            generationId,
            error: {
              code: "provider_output_invalid",
              message:
                "ChatGPT used product/sandbox tools (.dockerenv / /openai/project) instead of host AIFROST_TOOL. Retry.",
              retryable: true,
              generationId,
            },
          };
          return;
        }
      }
    }

    // Single clean delta so client transcript === stored history
    yield { type: "output_text.delta", generationId, delta: emitted };

    const message: NormalizedMessage = {
      id: newMessageId(),
      agentId: request.agentId,
      providerMessageId: null,
      role: "assistant",
      content: [textContent(emitted)],
      createdAt: new Date().toISOString(),
      metadata: { provider: this.id, source: "network+dom" },
    };
    yield {
      type: "generation.completed",
      generationId,
      messages: [message],
      usage: null,
    };
  }

  async cancel(ctx: ProviderPageContext, generationId: string): Promise<CancelResult> {
    this.cancelledGenerations.add(generationId);
    // Bound the set — a generation that fails before reaching the check would
    // otherwise leak its id forever.
    if (this.cancelledGenerations.size > 256) this.cancelledGenerations.clear();
    const clicked = await evalBool(
      ctx,
      `(function(){
        const btn = document.querySelector('button[data-testid="stop-button"]')
          || Array.from(document.querySelectorAll('button')).find(b => /stop/i.test(b.getAttribute('aria-label')||'') || /stop/i.test(b.textContent||''));
        if (btn) { btn.click(); return true; }
        return false;
      })()`,
    );
    await sleep(500);
    return {
      accepted: true,
      confirmedIdle: clicked,
      detail: clicked ? "stop_clicked" : "stop_button_not_found",
    };
  }

  async readHistory(ctx: ProviderPageContext): Promise<NormalizedMessage[]> {
    const result = await ctx.session.evaluate(`
      (function(){
        const out = [];
        const nodes = document.querySelectorAll('[data-message-author-role]');
        nodes.forEach((n, i) => {
          const role = n.getAttribute('data-message-author-role');
          if (role === 'user' || role === 'assistant') {
            out.push({ role, text: n.innerText || '' });
          }
        });
        return out;
      })()
    `);
    const rows = (result.value as Array<{ role: string; text: string }>) ?? [];
    return rows.map((r) => ({
      id: newMessageId(),
      agentId: ctx.agentId,
      providerMessageId: null,
      role: r.role as "user" | "assistant",
      content: [textContent(r.text)],
      createdAt: new Date().toISOString(),
      metadata: { provider: this.id },
    }));
  }

  async reconcileFinal(
    ctx: ProviderPageContext,
    generationId: string,
  ): Promise<FinalReconciliation> {
    const history = await this.readHistory(ctx);
    const last = [...history].reverse().find((m) => m.role === "assistant");
    return {
      generationId: generationId as FinalReconciliation["generationId"],
      messages: last ? [last] : [],
      matchedStream: Boolean(last),
      warnings: last ? [] : ["no assistant message in DOM"],
    };
  }

  private async ensureOnChatgpt(ctx: ProviderPageContext): Promise<void> {
    const href = await evalString(ctx, "location.href");
    if (!href.includes("chatgpt.com") && !href.includes("chat.openai.com")) {
      await ctx.session.navigate(CHATGPT_ORIGIN + "/");
      await sleep(2_000);
    }
  }

  private async fingerprint(ctx: ProviderPageContext): Promise<string | null> {
    const v = await ctx.session.evaluate(`
      (function(){
        const scripts = Array.from(document.scripts).map(s => s.src).filter(Boolean).slice(0,5);
        return JSON.stringify({ t: document.title, s: scripts });
      })()
    `);
    if (v.exception || v.value == null) return null;
    return `chatgpt:${hash(String(v.value))}`;
  }

  /** Reset capture buffers; patch fetch once to write into st.activeGenId. */
  private async armStreamCapture(ctx: ProviderPageContext, generationId: string): Promise<void> {
    await ctx.session.evaluate(`
      (function(genId){
        window.__AIFROST_CHATGPT__ = window.__AIFROST_CHATGPT__ || { buffers: {}, done: {}, errors: {} };
        const st = window.__AIFROST_CHATGPT__;
        st.activeGenId = genId;
        st.buffers[genId] = '';
        st.done[genId] = false;
        st.errors[genId] = null;
        // Prune stale per-generation buffers (e.g. a prior generation that
        // failed before cleanup) — page-side state must stay bounded.
        const keys = Object.keys(st.buffers);
        if (keys.length > 8) {
          for (const k of keys.slice(0, keys.length - 8)) {
            if (k === genId) continue;
            delete st.buffers[k]; delete st.done[k]; delete st.errors[k];
          }
        }
        if (st._patched) return true;
        st._patched = true;
        const orig = window.fetch.bind(window);
        window.fetch = async function(input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          const res = await orig(input, init);
          try {
            const g = st.activeGenId;
            // Only capture the streaming conversation POST while a generation
            // is armed. GET /backend-api/conversation/<id> returns the WHOLE
            // conversation JSON — capturing it contaminates the buffer with
            // every historical message.
            if (g && method !== 'GET' && /\\/backend-api\\/(f\\/)?conversation|\\/ces\\/v1\\//i.test(url)) {
              const clone = res.clone();
              const ct = (clone.headers.get('content-type')||'');
              if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
                (async () => {
                  const reader = clone.body && clone.body.getReader && clone.body.getReader();
                  if (!reader) {
                    const t = await clone.text();
                    st.buffers[g] = (st.buffers[g]||'') + t;
                    st.done[g] = true;
                    return;
                  }
                  const dec = new TextDecoder();
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    st.buffers[g] = (st.buffers[g]||'') + dec.decode(value, { stream: true });
                  }
                  st.done[g] = true;
                })().catch(e => { st.errors[g] = String(e); st.done[g] = true; });
              }
            }
          } catch (e) {}
          return res;
        };
        return true;
      })(${JSON.stringify(generationId)})
    `);
  }

  /**
   * Delete this generation's page-side capture buffers (including corrective
   * retry buffers like <genId>-hostfix / -toolfixN) and disarm the sniffer.
   */
  private async clearStreamCapture(ctx: ProviderPageContext, generationId: string): Promise<void> {
    try {
      await ctx.session.evaluate(`
        (function(prefix){
          const st = window.__AIFROST_CHATGPT__;
          if (!st) return;
          for (const k of Object.keys(st.buffers || {})) {
            if (k === prefix || k.startsWith(prefix + '-')) {
              delete st.buffers[k]; delete st.done[k]; delete st.errors[k];
            }
          }
          const a = String(st.activeGenId || '');
          if (a === prefix || a.startsWith(prefix + '-')) st.activeGenId = null;
        })(${JSON.stringify(generationId)})
      `);
    } catch {
      // Page may be gone — buffers die with it.
    }
  }

  /**
   * Up to two complete-JSON nudges after a truncated AIFROST_TOOL (Pi never sees these).
   */
  private async recoverIncompleteToolScaffold(
    ctx: ProviderPageContext,
    opts: {
      generationId: string;
      lastUserText: string;
      webInput: string;
      clientTools: CanonicalGenerationRequest["tools"];
      echoTexts: string[];
    },
  ): Promise<CanonicalToolIntent[] | null> {
    const tools = opts.clientTools ?? [];
    for (let i = 0; i < 2; i++) {
      const nudge = capWebUiSubmitText(buildIncompleteToolScaffoldNudge(tools));
      const fixGenId = `${opts.generationId}-toolfix${i}`;
      await this.armStreamCapture(ctx, fixGenId);
      const userCountFix = await countUserMessages(ctx);
      const fixSubmit = await this.submitPrompt(ctx, nudge);
      if (!fixSubmit.ok) continue;
      {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const n = await countUserMessages(ctx);
          if (n > userCountFix) break;
          await sleep(200);
        }
      }
      const baselineFix = (await readAssistantDom(ctx, opts.lastUserText)).trim();
      const fixed = await this.collectAssistantText(ctx, {
        generationId: fixGenId,
        lastUserText: opts.lastUserText,
        echoTexts: [opts.lastUserText, opts.webInput],
        expectTools: true,
        baselineAssistant: baselineFix,
        maxWaitMs: 75_000,
      });
      const parsed = parseHostToolIntents(fixed);
      if (parsed && parsed.length > 0) return parsed;
    }
    return null;
  }

  /**
   * Wait for a full assistant reply (network and/or DOM). Does not stream deltas.
   */
  private async collectAssistantText(
    ctx: ProviderPageContext,
    opts: {
      generationId: string;
      lastUserText: string;
      echoTexts: string[];
      expectTools: boolean;
      /** Last assistant DOM text before this turn's submit — never reuse it. */
      baselineAssistant?: string;
      maxWaitMs?: number;
    },
  ): Promise<string> {
    const {
      generationId,
      lastUserText,
      echoTexts,
      expectTools,
      baselineAssistant = "",
      maxWaitMs = 180_000,
    } = opts;
    const baseline = baselineAssistant.trim();
    let emitted = "";
    let sawStop = false;
    let stableTicks = 0;
    let incompleteIdleTicks = 0;
    const deadline = Date.now() + maxWaitMs;

    const isFresh = (t: string): boolean => {
      const s = (t || "").trim();
      if (!s) return false;
      if (
        baseline &&
        (s === baseline ||
          (s.startsWith(baseline.slice(0, 80)) &&
            baseline.length > 40 &&
            s.includes(baseline.slice(0, 40))))
      ) {
        // Same as pre-submit assistant (or still dominated by it)
        if (s === baseline) return false;
        // Allow only if clearly longer with new content after baseline
        if (baseline.length > 20 && s.startsWith(baseline) && s.length > baseline.length + 8) {
          return true;
        }
        if (s === baseline) return false;
        // Prefer rejecting near-duplicates of previous turn
        if (baseline.length > 30 && s.length > 30) {
          const a = baseline.slice(0, 120);
          const b = s.slice(0, 120);
          if (a === b) return false;
        }
      }
      return isUsefulAssistantText(s, lastUserText);
    };

    while (Date.now() < deadline) {
      const snap = await ctx.session.evaluate(`
        (function(genId){
          const st = window.__AIFROST_CHATGPT__;
          if (!st) return { text: '', done: false, error: null };
          return {
            text: st.buffers[genId] || '',
            done: !!st.done[genId],
            error: st.errors[genId],
          };
        })(${JSON.stringify(generationId)})
      `);
      const payload = snap.value as {
        text?: string;
        done?: boolean;
        error?: string | null;
      } | null;
      const raw = payload?.text ?? "";
      if (raw.length > 0) {
        const extracted = cleanAssistantAgainstEchoes(extractAssistantDeltas(raw), echoTexts);
        if (isFresh(extracted)) {
          if (extracted.length >= emitted.length || !isFresh(emitted)) {
            emitted = extracted;
          }
        }
      }

      const dom = await readAssistantDom(ctx, lastUserText);
      const domClean = dom ? cleanAssistantAgainstEchoes(dom, echoTexts) : "";
      // Only accept DOM if it is a NEW assistant bubble vs baseline
      if (domClean && isFresh(domClean) && (!baseline || domClean.trim() !== baseline)) {
        if (!emitted || preferDomOverThinking(emitted, domClean) === domClean) {
          // Don't replace short fresh network text with longer *old* content
          if (!baseline || domClean !== baseline) {
            emitted = preferFresh(emitted, domClean, baseline);
          }
        }
      }

      if (expectTools && looksLikeIncompleteToolScaffold(emitted)) {
        stableTicks = 0;
        // If generation is idle (send ready, no stop) with truncated JSON for ~3s,
        // stop waiting — caller will auto re-nudge. Avoids 180s hang on mid-stop.
        const stopBtn = await evalBool(ctx, STOP_BUTTON_EXPR);
        const sendReady = await evalBool(ctx, SEND_READY_EXPR);
        if (!stopBtn && sendReady) {
          incompleteIdleTicks += 1;
          if (incompleteIdleTicks >= 24) break;
        } else {
          incompleteIdleTicks = 0;
        }
        await sleep(250);
        continue;
      }
      incompleteIdleTicks = 0;

      // Refusal / short final prose — no need to wait full timeout
      if (
        emitted &&
        (looksLikeAifrostToolRefusal(emitted) ||
          (emitted.length < 200 &&
            !expectTools &&
            isFresh(emitted) &&
            !looksLikeIncompleteToolScaffold(emitted)))
      ) {
        const stopEarly = await evalBool(ctx, SEND_READY_EXPR);
        if (stopEarly && !looksLikeIncompleteToolScaffold(emitted)) {
          stableTicks += 2;
          if (stableTicks >= 2) break;
        }
      }

      const stop = await evalBool(ctx, STOP_BUTTON_EXPR);
      if (stop) {
        sawStop = true;
        stableTicks = 0;
      } else if (sawStop && isFresh(emitted)) {
        stableTicks += 1;
        if (stableTicks >= 4) break;
      } else if (!sawStop && isFresh(emitted)) {
        const sendReady = await evalBool(ctx, SEND_READY_EXPR);
        if (sendReady) {
          stableTicks += 1;
          if (stableTicks >= 6) break;
        }
      }

      if (payload?.done && isFresh(emitted) && !stop) {
        stableTicks += 1;
        if (stableTicks >= 3) break;
      }

      await sleep(250);
    }

    if (!isFresh(emitted)) {
      for (let i = 0; i < 20; i++) {
        const dom = cleanAssistantAgainstEchoes(
          await readAssistantDom(ctx, lastUserText),
          echoTexts,
        );
        if (isFresh(dom) && (!baseline || dom.trim() !== baseline)) {
          emitted = dom;
          break;
        }
        await sleep(400);
      }
    } else {
      const finalDom = cleanAssistantAgainstEchoes(
        await readAssistantDom(ctx, lastUserText),
        echoTexts,
      );
      if (isFresh(finalDom) && finalDom.trim() !== baseline && finalDom.length >= emitted.length) {
        emitted = preferFresh(emitted, finalDom, baseline);
      }
    }

    const out = cleanAssistantAgainstEchoes(emitted, echoTexts);
    // Final guard: never return the pre-submit assistant as this turn's answer
    if (baseline && out.trim() === baseline.trim()) return "";
    return out;
  }

  private async submitPrompt(
    ctx: ProviderPageContext,
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const limiter = getActiveRateLimiter();
    await limiter?.beforeWebUiSubmit({
      accountId: ctx.accountId,
      providerId: this.id,
    });
    const payload = JSON.stringify(text);
    // Large tool dumps used to hang default 30s Runtime.evaluate.
    const evalTimeoutMs = Math.min(120_000, 30_000 + Math.floor(text.length / 4));
    const result = await ctx.session.evaluate(
      `
      (function(text){
        const root = document.querySelector('#prompt-textarea')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('textarea');
        if (!root) return { ok: false, error: 'composer_not_found' };
        root.focus();
        if (root.isContentEditable || root.getAttribute('contenteditable') === 'true') {
          root.innerHTML = '';
          try {
            document.execCommand('insertText', false, text);
          } catch (e) {
            root.textContent = text;
            root.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
          }
        } else {
          const proto = window.HTMLTextAreaElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(root, text);
          else root.value = text;
          root.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // allow React state to enable send
        return { ok: true, staged: true, prompt: (root.innerText || root.value || '').slice(0, 80) };
      })(${payload})
    `,
      evalTimeoutMs,
    );
    if (result.exception) return { ok: false, error: result.exception };
    const staged = result.value as { ok?: boolean; error?: string } | null;
    if (!staged?.ok) return { ok: false, error: staged?.error ?? "stage_failed" };

    await sleep(350);

    const click = await ctx.session.evaluate(`
      (function(){
        const root = document.querySelector('#prompt-textarea')
          || document.querySelector('div[contenteditable="true"]')
          || document.querySelector('textarea');
        const form = root && root.closest('form');
        const scoped = form ? Array.from(form.querySelectorAll('button')) : [];
        const send = document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('button[data-testid="composer-send-button"]')
          || scoped.find(b => /^send\\b/i.test((b.getAttribute('aria-label')||'').trim()))
          || Array.from(document.querySelectorAll('button')).find(b =>
              /send/i.test(b.getAttribute('data-testid')||'') ||
              /^send(\\s+message)?$/i.test((b.getAttribute('aria-label')||'').trim()));
        if (!send) {
          if (root) {
            root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
            return { ok: true, via: 'enter' };
          }
          return { ok: false, error: 'send_not_found' };
        }
        if (send.disabled) return { ok: false, error: 'send_disabled' };
        send.click();
        return { ok: true, via: 'click' };
      })()
    `);
    const v = click.value as { ok?: boolean; error?: string } | null;
    if (click.exception) return { ok: false, error: click.exception };
    if (!v?.ok) return { ok: false, error: v?.error ?? "submit_failed" };
    limiter?.afterWebUiSubmit(ctx.accountId, this.id);
    return { ok: true };
  }
}

function incompleteToolFail(
  generationId: string,
): Extract<CanonicalGenerationEvent, { type: "generation.failed" }> {
  const gid = generationId as GenerationId;
  return {
    type: "generation.failed",
    generationId: gid,
    error: {
      code: "tool_scaffold_incomplete",
      message: "ChatGPT emitted a truncated AIFROST_TOOL block (incomplete JSON). Retry the turn.",
      retryable: true,
      generationId: gid,
    },
  };
}

async function evalString(ctx: ProviderPageContext, expression: string): Promise<string> {
  const r = await ctx.session.evaluate(expression);
  if (r.exception) return "";
  return r.value == null ? "" : String(r.value);
}

async function readRateLimitBanner(ctx: ProviderPageContext): Promise<string> {
  const t = await evalString(
    ctx,
    `(function(){
      const body = (document.body && document.body.innerText) || '';
      if (/requests too quickly|limited access to your conversations|too many concurrent/i.test(body)) {
        return body.slice(0, 800);
      }
      const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
      return dlg ? (dlg.innerText || '').slice(0, 800) : '';
    })()`,
  );
  return t;
}

async function evalBool(ctx: ProviderPageContext, expression: string): Promise<boolean> {
  const r = await ctx.session.evaluate(expression);
  return Boolean(r.value) && !r.exception;
}

async function countUserMessages(ctx: ProviderPageContext): Promise<number> {
  const r = await ctx.session.evaluate(
    `document.querySelectorAll('[data-message-author-role="user"]').length`,
  );
  return typeof r.value === "number" ? r.value : 0;
}

async function readAssistantDom(ctx: ProviderPageContext, lastUserText = ""): Promise<string> {
  const r = await ctx.session.evaluate(`
    (function(userText){
      const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      // Walk from end; skip empty/thinking/echoes of the user prompt
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const md = n.querySelector('.markdown, .prose, [class*="markdown"]');
        let t = ((md ? md.innerText : n.innerText) || '').trim();
        t = t.replace(/^Pro thinking\\s*/i, '').replace(/^Thinking\\s*/i, '').trim();
        if (!t) continue;
        if (/^(pro\\s+)?thinking\\.?$/i.test(t)) continue;
        if (userText && t === userText) continue;
        // Strip accidental user-prefix glued onto assistant (DOM sometimes includes it)
        if (userText && t.startsWith(userText)) {
          t = t.slice(userText.length).replace(/^\\s+/, '');
        }
        if (!t) continue;
        if (userText && t === userText) continue;
        return t;
      }
      return '';
    })(${JSON.stringify(lastUserText)})
  `);
  if (r.exception || r.value == null) return "";
  return stripUserEchoPrefix(String(r.value), lastUserText);
}

function isUsefulAssistantText(t: string, lastUserText = ""): boolean {
  const s = cleanAssistantText(t, lastUserText);
  if (!s) return false;
  // Ignore thinking placeholders
  if (/^(pro\s+)?thinking\.?$/i.test(s)) return false;
  // ChatGPT product UI chrome (not real assistant prose)
  if (/^Worked for (a second|\d+s)\.?$/i.test(s.trim())) return false;
  if (/^Searching( the web)?\.?$/i.test(s.trim())) return false;
  // Ignore accidental capture of the user prompt as "assistant"
  if (lastUserText && s.trim() === lastUserText.trim()) return false;
  // Ignore PE instruction bubble captured as assistant (legacy + compact v1)
  if (/^You are the reasoning model for a local coding agent/i.test(s)) return false;
  if (/^HOST tools run on the user's laptop/i.test(s)) return false;
  if (/^AIFROST v1\b/i.test(s)) return false;
  if (/^TR host\b/i.test(s)) return false;
  if (/^TR HOST\b/i.test(s)) return false;
  if (/^U:\s*$/i.test(s)) return false;
  return s.length > 0;
}

/** Remove user prompt if it was glued to the start of captured assistant text. */
export function stripUserEchoPrefix(assistant: string, userText: string): string {
  let s = (assistant || "").trim();
  const u = (userText || "").trim();
  if (!s || !u) return s;
  if (s === u) return "";
  if (s.startsWith(u)) {
    s = s.slice(u.length).replace(/^\s+/, "");
  }
  // Multi-line joined user (retries) as prefix
  const firstLine = u.split("\n")[0]?.trim() ?? "";
  if (firstLine.length > 8 && s.startsWith(firstLine) && s.length > firstLine.length + 10) {
    // only strip single-line if full u didn't match — avoid over-stripping
  }
  return s.trim();
}

function cleanAssistantText(t: string, lastUserText = ""): string {
  let s = (t || "")
    .replace(/^\s*Pro thinking\s*/i, "")
    .replace(/^\s*Thinking\s*/i, "")
    .trim();
  s = stripUserEchoPrefix(s, lastUserText);
  // PE instruction leaked into assistant capture (legacy or compact v1)
  s = stripHarnessPeEcho(s);
  return s;
}

function cleanAssistantAgainstEchoes(t: string, echoes: string[]): string {
  let s = t || "";
  for (const echo of echoes) {
    s = cleanAssistantText(s, echo);
  }
  s = cleanAssistantText(s, "");
  return s;
}

/** Hard cap for text typed into ChatGPT composer (CDP + React). */
export const WEB_UI_SUBMIT_MAX_CHARS = 12_000;

export function capWebUiSubmitText(text: string, max = WEB_UI_SUBMIT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const mark = "\n…[truncated by aifrost for WebUI submit]";
  const budget = Math.max(0, max - mark.length);
  return `${text.slice(0, budget)}${mark}`;
}

function preferDomOverThinking(prev: string, dom: string): string {
  if (!isUsefulAssistantText(dom)) return prev;
  if (!isUsefulAssistantText(prev)) return dom;
  return dom.length >= prev.length ? dom : prev;
}

/** Prefer newer short replies over longer *previous-turn* DOM text. */
function preferFresh(prev: string, next: string, baseline: string): string {
  const p = (prev || "").trim();
  const n = (next || "").trim();
  if (!n) return p;
  if (!p) return n;
  if (baseline && n === baseline.trim()) return p;
  if (baseline && p === baseline.trim()) return n;
  // Prefer network/short fresh over huge stale
  if (baseline && n.includes(baseline.slice(0, 50)) && baseline.length > 80) {
    return p && !p.includes(baseline.slice(0, 50)) ? p : n;
  }
  return preferDomOverThinking(p, n);
}

function extractConversationId(href: string): string | null {
  const m = href.match(/\/c\/([a-zA-Z0-9-]+)/);
  return m?.[1] ?? null;
}

function extractAssistantDeltas(rawStream: string): string {
  let text = "";
  const lines = rawStream.split("\n");
  for (const line of lines) {
    const s = line.replace(/^data:\s?/, "").trim();
    if (!s || s === "[DONE]") continue;
    try {
      const j = JSON.parse(s) as Record<string, unknown>;
      text += walkForText(j);
    } catch {
      // non-json chunks ignored
    }
  }
  if (!text) {
    const re2 = /"content"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re2.exec(rawStream))) {
      try {
        text += JSON.parse(`"${m[1]}"`);
      } catch {
        text += m[1];
      }
    }
  }
  return text;
}

function walkForText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return "";
  if (Array.isArray(node)) return node.map(walkForText).join("");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    // ChatGPT SSE often has delta / message content parts
    if (typeof o.v === "string" && o.p && String(o.p).includes("content")) {
      return o.v;
    }
    // Array-valued patch ops, e.g. {p:"/message/content/parts", v:["a","b"]}
    if (
      Array.isArray(o.v) &&
      o.p &&
      String(o.p).includes("content") &&
      o.v.every((x) => typeof x === "string")
    ) {
      return (o.v as string[]).join("");
    }
    if (o.delta && typeof o.delta === "object") {
      const d = o.delta as Record<string, unknown>;
      if (typeof d.content === "string") return d.content;
      if (Array.isArray(d.parts)) return d.parts.filter((x) => typeof x === "string").join("");
    }
    if (o.message && typeof o.message === "object") {
      const msg = o.message as Record<string, unknown>;
      const content = msg.content as Record<string, unknown> | undefined;
      if (content && Array.isArray(content.parts)) {
        return content.parts.filter((x) => typeof x === "string").join("");
      }
    }
    let acc = "";
    for (const v of Object.values(o)) acc += walkForText(v);
    return acc;
  }
  return "";
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
