import type { BrowserBackend, BrowserStartConfig } from "./backend.js";
import { MockBrowserBackend } from "./mock/backend.js";
import { ChromiumBrowserBackend } from "./chromium/backend.js";
import { logger } from "../observability/logger.js";

export type BrowserKind = "mock" | "chromium" | "brave" | "auto";

export interface CreateBrowserOptions {
  kind?: BrowserKind;
  startConfig?: BrowserStartConfig;
  headless?: boolean;
}

/**
 * Select browser backend.
 * - mock: in-process fixture (tests)
 * - chromium / brave: Chromium-family CDP (Brave preferred when installed)
 * - auto: chromium if binary present, else mock
 */
export async function createBrowserBackend(
  opts: CreateBrowserOptions = {},
): Promise<{ backend: BrowserBackend; kind: "mock" | "chromium" }> {
  const requested = opts.kind ?? (process.env.AIFROST_BROWSER as BrowserKind | undefined) ?? "auto";

  if (requested === "mock") {
    const backend = new MockBrowserBackend();
    await backend.start(opts.startConfig ?? {});
    return { backend, kind: "mock" };
  }

  if (requested === "chromium" || requested === "brave") {
    const backend = new ChromiumBrowserBackend({
      requireBinary: true,
      headless: opts.headless,
    });
    await backend.start(opts.startConfig ?? {});
    logger.info(
      { binary: backend.getBinaryPath(), brand: backend.getBrand() },
      "using Chromium-family browser backend",
    );
    return { backend, kind: "chromium" };
  }

  // auto
  const candidate = new ChromiumBrowserBackend({
    requireBinary: false,
    headless: opts.headless,
  });
  if (candidate.binaryAvailable()) {
    await candidate.start(opts.startConfig ?? {});
    logger.info(
      { binary: candidate.getBinaryPath(), brand: candidate.getBrand() },
      "using Chromium-family browser backend",
    );
    return { backend: candidate, kind: "chromium" };
  }

  logger.warn("No Brave/Chrome binary found; falling back to MockBrowserBackend");
  const mock = new MockBrowserBackend();
  await mock.start(opts.startConfig ?? {});
  return { backend: mock, kind: "mock" };
}
