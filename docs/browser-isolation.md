# Browser isolation model (Aifrost × Brave)

## What you should see on macOS

| Process                        | Role                                            |
| ------------------------------ | ----------------------------------------------- |
| **Your normal Brave**          | Personal browsing — never used by Aifrost       |
| **Aifrost Brave × N accounts** | One headed process **per ChatGPT `account_id`** |

Example with one login (`acct_main`) and five Pi agents:

```text
Dock:  [ Brave (you) ]  [ Brave (aifrost · acct_main · up to 5 tabs) ]
```

Example with two ChatGPT logins:

```text
Dock:  [ Brave (you) ]  [ Brave · acct_main · tabs… ]  [ Brave · acct_work · tabs… ]
```

**Many agents do not mean many Dock icons** — only many **tabs** inside the
account’s Aifrost Brave (capped; see below).

---

## Product rules (v1)

1. **Never** attach to the user’s personal Brave profile.
2. **One process per `account_id`** via isolated  
   `state/profiles/<account_id>/chromium` (`--user-data-dir`).
3. **One tab (CDP target) per agent runtime** inside that process.
4. **Sticky process (default):** while `aifrost serve` is running, the account
   browser stays up even if every agent is destroyed — avoids Dock thrash and
   preserves ChatGPT login / CF cookies.
5. **Hard stop on serve shutdown** (SIGINT/SIGTERM): close sessions, stop
   profile processes, kill orphans under `state/profiles/*/chromium`.
6. **Tab cap:** `AIFROST_MAX_TABS_PER_ACCOUNT` (default **10**, max 50).

### Env knobs

| Variable                       | Default   | Meaning                                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| `AIFROST_MAX_TABS_PER_ACCOUNT` | `10`      | Max concurrent agent tabs per account process                                              |
| `AIFROST_BROWSER_IDLE_EXIT`    | off       | If `1`/`true`, kill account Brave when last agent releases (not recommended for daily use) |
| `AIFROST_HEADLESS`             | `0`       | Keep headed for ChatGPT                                                                    |
| `AIFROST_STATE_DIR`            | `./state` | Profiles live under `<state>/profiles/<account_id>/chromium`                               |

---

## Brave Containers vs Aifrost isolation

You use **Brave Containers** in personal browsing: one process, many containers,
cookie/storage isolation per container — great UX for multi-account sites.

| Mechanism                                   | Isolation                       | Durable login                               | CDP automation                                                                                   |
| ------------------------------------------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Brave Containers** (product UI)           | Strong (tab container)          | Yes, in that profile                        | **Not a supported Aifrost control plane** today (no stable CDP “put this target in container X”) |
| **Separate `--user-data-dir`** (Aifrost v1) | Strongest (whole profile)       | Yes (disk profile)                          | Full CDP control                                                                                 |
| **CDP `BrowserContext`** (future)           | Strong (cookie jar per context) | Needs design (contexts are often ephemeral) | First-class in CDP / Playwright                                                                  |

**Aifrost v1 maps your mental model this way:**

```text
Your Brave Containers  ≈  Aifrost account processes (isolation boundary)
Tabs inside a container ≈  Agent tabs inside one account process
```

We intentionally **do not** drive Brave’s Containers UI from Aifrost. Relying on
undocumented container chrome would couple us to UI churn and break headed
automation. The automation-native equivalent of “container per account” is
either:

- **v1:** process + `user-data-dir` per account (current, durable logins), or
- **v2 (planned):** one Aifrost process + **CDP BrowserContext per account**
  once we can persist context storage across restarts as reliably as a profile.

### Why not one process for all accounts tomorrow?

Chromium allows only **one** process per `user-data-dir`. Multiple ChatGPT
logins need multiple cookie jars. Without durable multi-context storage:

- Logins would reset on every serve restart, or
- Accounts would bleed cookies if forced into one default context.

So multi-account isolation stays **one process per account** until BrowserContext
persistence is productized.

---

## Lifecycle (sticky)

```text
serve start
  └─ no browser yet

first agent on acct_main
  └─ launch or attach Aifrost Brave (profile acct_main)
  └─ Target.createTarget → tab 1

more agents on acct_main
  └─ same process, new tabs (until MAX_TABS)

agent deleted
  └─ close that tab; process **stays** (sticky)

serve stop (SIGINT)
  └─ close all tabs, hard-stop all account processes, orphan sweep
```

If you still see extra Dock Braves: leftover processes from an old crash or a
second `account_id`. Quit those windows or restart serve cleanly; shutdown now
sweeps `state/profiles/*/chromium` orphans.

---

## Hands-off rule

The Aifrost Brave window is **automation-owned**. Watching is fine; typing,
navigating, logging out, or closing tabs can race the driver and break agents.
Use personal Brave for everything else.

---

## Follow-up: Brave Containers API / single-process multi-account

**Status (2026-08): research only — not product path yet.**

### What exists today (Brave 1.92+)

Brave shipped **native Containers** (UI): isolate cookies/site data per tab group
so multiple logins to the same site can coexist in one window. User-facing:

- Enable: `brave://settings` → Content → Containers (or `brave://flags` during rollout)
- Manage containers; open tabs “in a container”

This is the same _idea_ as Firefox Multi-Account Containers.

### Is there an API Aifrost can call?

| Surface                                          | Reality for Aifrost                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public REST “Containers API”**                 | **No** — not a documented remote API                                                                                                                                                                          |
| **Firefox-style `browser.contextualIdentities`** | **Firefox-only** WebExtension API ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities)). Chromium/Brave do **not** expose this for extensions the same way |
| **Chrome DevTools Protocol**                     | No stable `Target.createTarget({ containerId })` (or equivalent) in public CDP for Brave Containers as of this writing                                                                                        |
| **Unofficial / UI automation**                   | Possible in theory (DOM/settings chrome); brittle, non-portable, not product-grade                                                                                                                            |
| **CDP `Target.createBrowserContext`**            | **Yes, standard** — cookie-jar isolation per context in **one process**. Closest automation-native “container.” Persistence across restarts is the open design problem                                        |

**Conclusion:** There is **no easy, supported Brave Containers automation API** today that lets Aifrost say “open chatgpt.com in container `acct_main`” under a single process. Single-host multi-account for Aifrost remains:

1. **v1 (now):** 1 process × 1 `user-data-dir` per `account_id` (works on macOS and future Ubuntu host the same way)
2. **v2 (candidate):** 1 process × N CDP `BrowserContext`s with durable storage export/import per account
3. **v2b (if Brave ships):** official extension/CDP hooks for Containers — re-evaluate then

Ubuntu dedicated host later does **not** change this: same Chromium process model; headless still blocked for ChatGPT; headed display (Xvfb/real GPU) still required.

### When to reopen this

- Brave documents a Containers WebExtension or CDP surface
- Or we implement durable BrowserContext persistence and accept one Dock/process for all accounts
- Spike: prove ChatGPT login survives restart inside non-default BrowserContext

Track under product backlog as **browser isolation v2**; do not block Pi/agentic work on it.

---

## Related

- `src/browser/chromium/backend.ts` — process/tab policy
- `src/browser/chromium/process.ts` — launch, CDP reuse, personal-profile guard
- `docs/architecture-harness.md` — product API surface
- `docs/harness-pi.md` — Pi integration (current priority)
