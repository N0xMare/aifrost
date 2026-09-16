/**
 * ChatGPT Web "Projects" organization helpers.
 *
 * Goal: keep Aifrost agent conversations under a named project (default
 * "aifrost") so the main chat history stays for human use.
 *
 * Observed (2026-09, chatgpt.com):
 * - Projects live in the global sidebar as
 *   `[data-app-action-sidebar-project-id="g-p-…"]` elements; the project chats
 *   container carries `data-sidebar-project-container-id="project:g-p-…"`.
 * - New in-project chat: sidebar button `aria-label="New chat in <name>"`
 *   (rendered when the project section is expanded).
 * - Project chats get `/g/g-p-<id>-<slug>/c/<conv>` URLs after first send;
 *   the `/g/g-p-…/project` home form redirects to / in the current UI.
 * - Global sidebar "New chat" leaves the project — do not use it.
 *
 * This is best-effort WebUI automation (no public Projects API).
 */

import type { ProviderPageContext } from "../contract.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";

export interface ChatGptProjectRef {
  name: string;
  /** e.g. g-p-0000000000000000000000000000aa */
  gizmoId: string;
  /** Canonical project home URL with composer */
  homeUrl: string;
}

/** Cache by accountId so we do not re-scan /projects every agent. */
const projectCache = new Map<string, ChatGptProjectRef>();

export function resolveChatGptProjectName(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | null {
  const raw = (env.AIFROST_CHATGPT_PROJECT ?? "aifrost").trim();
  if (!raw || raw.toLowerCase() === "none" || raw === "0" || raw === "off") {
    return null;
  }
  return raw;
}

export function clearProjectCache(accountId?: string): void {
  if (accountId) projectCache.delete(accountId);
  else projectCache.clear();
}

export function getCachedProject(accountId: string): ChatGptProjectRef | null {
  return projectCache.get(accountId) ?? null;
}

export function projectHomeUrl(gizmoId: string, slug?: string): string {
  const id = gizmoId.startsWith("g-p-") ? gizmoId : `g-p-${gizmoId}`;
  if (slug) return `${CHATGPT_ORIGIN}/g/${id}-${slug}/project`;
  return `${CHATGPT_ORIGIN}/g/${id}/project`;
}

export function projectConversationUrl(
  gizmoId: string,
  conversationId: string,
  slug?: string,
): string {
  const id = gizmoId.startsWith("g-p-") ? gizmoId : `g-p-${gizmoId}`;
  const conv = conversationId.replace(/^\/c\//, "");
  if (slug) return `${CHATGPT_ORIGIN}/g/${id}-${slug}/c/${conv}`;
  return `${CHATGPT_ORIGIN}/g/${id}/c/${conv}`;
}

export function extractProjectGizmoId(href: string): string | null {
  const m = href.match(/\/g\/(g-p-[a-zA-Z0-9]+)/);
  return m?.[1] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evalJson<T>(ctx: ProviderPageContext, expression: string): Promise<T | null> {
  const r = await ctx.session.evaluate(expression);
  if (r.exception) return null;
  return (r.value as T) ?? null;
}

async function evalString(ctx: ProviderPageContext, expression: string): Promise<string> {
  const r = await ctx.session.evaluate(expression);
  if (r.exception || r.value == null) return "";
  return String(r.value);
}

/**
 * Locate a project in the global sidebar. Current ChatGPT renders projects as
 * `[data-app-action-sidebar-project-id="g-p-…"]` elements whose text is the
 * project name — no /projects table navigation needed.
 */
async function findProjectInSidebar(
  ctx: ProviderPageContext,
  projectName: string,
): Promise<ChatGptProjectRef | null> {
  const found = await evalJson<{ gizmoId: string } | null>(
    ctx,
    `(() => {
      const want = ${JSON.stringify(projectName.trim().toLowerCase())};
      const els = Array.from(
        document.querySelectorAll('[data-app-action-sidebar-project-id]'),
      );
      const el = els.find(
        (e) => (e.textContent || '').trim().toLowerCase() === want,
      );
      if (!el) return null;
      const gid = el.getAttribute('data-app-action-sidebar-project-id');
      return gid ? { gizmoId: gid } : null;
    })()`,
  );
  if (!found?.gizmoId) return null;
  return {
    name: projectName,
    gizmoId: found.gizmoId,
    homeUrl: projectHomeUrl(found.gizmoId),
  };
}

/**
 * Ensure a ChatGPT project with the given name exists and return its ref.
 * Discovery is sidebar-based; project URLs (/g/g-p-…/project) redirect to /
 * in the current UI, so the gizmo id is used for caching/identity only.
 */
export async function ensureChatGptProject(
  ctx: ProviderPageContext,
  projectName: string,
): Promise<ChatGptProjectRef> {
  const cached = projectCache.get(ctx.accountId);
  if (cached && cached.name.toLowerCase() === projectName.toLowerCase()) {
    const still = await findProjectInSidebar(ctx, projectName);
    if (still) return still;
    projectCache.delete(ctx.accountId);
  }

  // The sidebar hydrates asynchronously after navigation — poll before
  // concluding the project is absent.
  let ref = await findProjectInSidebar(ctx, projectName);
  if (!ref) {
    const deadline = Date.now() + 12_000;
    while (!ref && Date.now() < deadline) {
      await sleep(700);
      ref = await findProjectInSidebar(ctx, projectName);
    }
  }
  if (!ref) {
    const created = await tryCreateProject(ctx, projectName);
    if (created) {
      const deadline = Date.now() + 10_000;
      while (!ref && Date.now() < deadline) {
        await sleep(700);
        ref = await findProjectInSidebar(ctx, projectName);
      }
    }
  }

  if (!ref) {
    throw new Error(
      `ChatGPT project "${projectName}" not found and could not be created. ` +
        `Create it once in the WebUI, or set AIFROST_CHATGPT_PROJECT=none to use top-level chats.`,
    );
  }
  projectCache.set(ctx.accountId, ref);
  return ref;
}

/**
 * Put the composer into "new chat in project" context. The current UI keeps
 * the URL at / — project scope shows as a chip in the composer form — so we
 * click the sidebar's "New chat in <name>" button, expanding the project
 * section first if the button isn't rendered yet.
 */
export async function openNewChatInProject(
  ctx: ProviderPageContext,
  project: ChatGptProjectRef,
): Promise<{ providerUrl: string; gizmoId: string }> {
  const nameLit = JSON.stringify(project.name);
  const gidLit = JSON.stringify(`project:${project.gizmoId}`);

  const clickNewChat = async (): Promise<boolean> =>
    Boolean(
      await evalJson<boolean>(
        ctx,
        `(() => {
          const want = ('new chat in ' + ${nameLit}).toLowerCase();
          const container =
            document.querySelector('[data-sidebar-project-container-id=' + JSON.stringify(${gidLit}) + ']')
            || document;
          const scoped = Array.from(container.querySelectorAll('button'));
          const btn =
            scoped.find((b) =>
              (b.getAttribute('aria-label') || '').trim().toLowerCase() === want,
            ) ||
            Array.from(document.querySelectorAll('button')).find((b) =>
              (b.getAttribute('aria-label') || '').trim().toLowerCase() === want,
            );
          if (!btn || btn.offsetParent === null) return false;
          btn.click();
          return true;
        })()`,
      ),
    );

  if (!(await clickNewChat())) {
    // Project section likely collapsed — expand via the project element.
    await evalJson<boolean>(
      ctx,
      `(() => {
        const el = document.querySelector('[data-app-action-sidebar-project-id=' + JSON.stringify(${JSON.stringify(project.gizmoId)}) + ']');
        if (!el) return false;
        const toggle =
          el.querySelector('button[aria-label*="oggle"]') ||
          el.closest('div')?.querySelector('button[aria-label*="oggle"]');
        (toggle || el).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
        return true;
      })()`,
    );
    await sleep(1_200);
    await clickNewChat();
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await hasComposer(ctx)) break;
    await sleep(300);
  }

  const href = await evalString(ctx, "location.href");
  return {
    providerUrl: href.includes("chatgpt.com") ? href : CHATGPT_ORIGIN + "/",
    gizmoId: project.gizmoId,
  };
}

async function hasComposer(ctx: ProviderPageContext): Promise<boolean> {
  return Boolean(
    await evalJson<boolean>(
      ctx,
      `!!(document.querySelector('#prompt-textarea')
        || document.querySelector('[contenteditable="true"]')
        || document.querySelector('textarea'))`,
    ),
  );
}

async function tryCreateProject(ctx: ProviderPageContext, projectName: string): Promise<boolean> {
  // Click "Add new project" / "New project" in the sidebar
  const started = await evalJson<{ ok: boolean }>(
    ctx,
    `(() => {
      const btn =
        document.querySelector('[aria-label="New project"]')
        || document.querySelector('[aria-label="Add new project"]')
        || Array.from(document.querySelectorAll('button')).find((b) =>
          /^(add )?new project$/i.test((b.getAttribute("aria-label") || b.innerText || "").trim()),
        );
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    })()`,
  );
  if (!started?.ok) return false;
  await sleep(1_000);

  // Fill name into focused input / dialog
  const filled = await evalJson<{ ok: boolean }>(
    ctx,
    `(() => {
      const name = ${JSON.stringify(projectName)};
      const input =
        document.querySelector('input[type="text"]')
        || document.querySelector('form input')
        || document.querySelector('[role="dialog"] input')
        || document.querySelector('input');
      if (!input) return { ok: false };
      input.focus();
      const proto = window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(input, name);
      else input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Create / confirm
      const create =
        Array.from(document.querySelectorAll('button')).find((b) =>
          /create( project)?/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()),
        ) || null;
      if (create) create.click();
      else {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
          }),
        );
      }
      return { ok: true };
    })()`,
  );
  if (!filled?.ok) return false;
  await sleep(2_500);
  return true;
}
