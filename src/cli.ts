#!/usr/bin/env node
import { createDefaultProviderRegistry } from "./providers/registry.js";
import { AgentRegistry } from "./core/agent-registry.js";
import { startServer } from "./api/server.js";
import { isLoopbackHost, resolveAuthConfig } from "./api/auth.js";
import { logger } from "./observability/logger.js";
import { createBrowserBackend } from "./browser/factory.js";
import { closeDb, openDb } from "./persistence/db.js";
import { AgentStore } from "./persistence/repositories.js";
import { AccountRateLimitController } from "./core/account-rate-limit.js";
import { setActiveRateLimiter } from "./core/rate-limit-global.js";
import { SqliteAccountRateLimitStore } from "./persistence/rate-limit-store.js";

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "serve" && cmd !== undefined) {
    console.error("Usage: aifrost serve");
    process.exit(1);
  }

  const host = process.env.AIFROST_HOST ?? "127.0.0.1";
  const port = Number(process.env.AIFROST_PORT ?? 8787);

  const auth = resolveAuthConfig(process.env as Record<string, string | undefined>, {
    token: "dev-token-change-me",
  });
  const loopback = isLoopbackHost(host);
  if (auth.mode === "none") {
    if (!loopback) {
      logger.warn(
        { host },
        "AIFROST_AUTH=none with non-loopback bind — anyone who can reach the port has full control",
      );
    } else {
      logger.info("AIFROST_AUTH=none — API auth disabled (local dev)");
    }
  } else if (auth.token === "dev-token-change-me") {
    if (!loopback) {
      console.error(
        "Refusing to bind a non-loopback host with the default auth token. " +
          "Set AIFROST_AUTH_TOKEN to a strong secret, or set AIFROST_AUTH=none explicitly.",
      );
      process.exit(1);
    }
    logger.warn(
      "Using default AIFROST_AUTH_TOKEN (loopback only); set a strong token for any non-dev use",
    );
  }

  const db = openDb(process.env.AIFROST_STATE_DIR);
  const store = new AgentStore(db);
  const rateLimiter = new AccountRateLimitController({
    store: new SqliteAccountRateLimitStore(db),
  });
  setActiveRateLimiter(rateLimiter);

  const { backend: browser, kind } = await createBrowserBackend({
    kind: (process.env.AIFROST_BROWSER as "mock" | "chromium" | "brave" | "auto") ?? "auto",
  });
  const providers = createDefaultProviderRegistry();
  const agents = new AgentRegistry(browser, providers, store, rateLimiter);
  agents.loadFromStore();

  const app = await startServer({
    host,
    port,
    auth,
    agents,
    providers,
    rateLimiter,
    store,
  });

  logger.info({ host, port, browser: kind, auth: auth.mode }, "Aifrost listening");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    try {
      await app.close();
      setActiveRateLimiter(null);
      await browser.shutdown();
      closeDb(db);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
