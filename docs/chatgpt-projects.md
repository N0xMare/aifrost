# ChatGPT Projects integration (Aifrost)

## Goal

Human chats stay in the normal ChatGPT history. **Aifrost agents** for an
account live under a single ChatGPT **Project** (default name: `aifrost`)
on the **Chat** surface (not ChatGPT Work — deferred / out of scope).

```text
Personal Brave / your normal chatgpt.com use
  └─ main history (not Aifrost)

Aifrost Brave · account_id=acct_main
  └─ Project "aifrost"
       ├─ agent chat 1 (tab)
       ├─ agent chat 2 (tab)
       └─ …
```

## Observed WebUI facts (verified live 2026-09)

| Surface                       | How Aifrost uses it                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Project discovery             | Sidebar element attribute `data-app-action-sidebar-project-id="g-p-…"` + visible name |
| New chat **in** project       | Sidebar action button `aria-label="New chat in aifrost"`                              |
| In-project composer indicator | `aifrost` chip inside the composer form; URL stays `/` (SPA, server-side assoc.)      |
| Chat inside project           | `https://chatgpt.com/c/<conversationId>` (plain URL; project assoc. is server-side)   |
| `/g/g-p-…/project` home URLs  | **Dead** — redirect to `/`; do not use                                                |
| Sidebar global **New chat**   | **Do not use** for agents — leaves the project                                        |

Project URLs/forms drift — the code treats the sidebar attributes and the
`New chat in <name>` button as the contract, not URL shapes.

## Config

| Env                            | Default   | Meaning                            |
| ------------------------------ | --------- | ---------------------------------- |
| `AIFROST_CHATGPT_PROJECT`      | `aifrost` | Project name to ensure/use         |
| `AIFROST_CHATGPT_PROJECT=none` | —         | Disable; top-level chats as before |

## Runtime flow

1. `createConversation` → `ensureChatGptProject(name)`
   - cache hit → click the project's `New chat in <name>` button
   - else scan sidebar attributes (polls — sidebar hydrates late)
   - if missing → best-effort **New project** dialog → re-scan
   - on failure → warn via logger, fall back to top-level chat
2. First turn submits into that composer → conversation created **in** the
   project; URL becomes `/c/<id>`; `provider_conversation_id` is synced after
   the first completed generation
3. Resume: navigate to the stored `/c/<id>` URL directly

## Code

- `src/providers/chatgpt-web/projects.ts` — ensure / open / discovery
- `src/providers/chatgpt-web/adapter.ts` — `createConversation` / `openConversation`

## Surfaces (Chat vs Work)

Aifrost drives **Chat** inside the project (composer + stream capture +
`AIFROST_TOOL`). ChatGPT **Work** (July 2026) is a separate agent product
(plugins, long-running tasks, credits shared with Codex). It is **not**
used as an Aifrost path. Do not start Work conversations from
`createConversation`. Avoid running Work/Codex on the same account while
Aifrost is generating (shared short-window limits). See
[chatgpt-rate-limits.md](./chatgpt-rate-limits.md).

## Limitations

- Unofficial WebUI automation; selectors/URLs can change
- Projects may require Plus/Pro
- Global “New chat” must never be used for agent create when project mode is on
- Existing top-level agent chats are **not** auto-moved (new agents only unless we add migrate later)

## Manual verify

1. Restart Aifrost with default project name
2. `POST /v1/agents` chatgpt-web `acct_main`
3. In Aifrost Brave: composer should show an `aifrost` project chip; after the
   first turn the chat appears under the project in the sidebar
4. Human root chats remain outside the project
