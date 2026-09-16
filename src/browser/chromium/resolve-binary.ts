import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Resolve a Chromium-family browser binary for Aifrost.
 * Preference: explicit env → Brave → Chrome → Chromium → Chrome for Testing paths.
 */
export function resolveChromiumBinary(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.AIFROST_CHROMIUM_BIN,
    process.env.AIFROST_BRAVE_BIN,
    // macOS apps
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    // common PATH names
    "brave-browser",
    "brave",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c.includes("/") || c.endsWith(".app/Contents/MacOS/Brave Browser") || c.includes(".app/")) {
      if (existsSync(c)) return c;
      continue;
    }
    const which = spawnSync("which", [c], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) {
      return which.stdout.trim();
    }
  }
  return null;
}

export function detectBrowserBrand(
  binaryPath: string,
): "brave" | "chrome" | "chromium" | "unknown" {
  const p = binaryPath.toLowerCase();
  if (p.includes("brave")) return "brave";
  if (p.includes("chrome for testing")) return "chrome";
  if (p.includes("google chrome") || p.includes("google-chrome") || p.endsWith("/chrome")) {
    return "chrome";
  }
  if (p.includes("chromium")) return "chromium";
  return "unknown";
}
