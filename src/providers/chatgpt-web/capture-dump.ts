/**
 * Debug capture dump — writes per-generation raw capture artifacts to disk so a
 * failed live ChatGPT turn is debuggable after the fact. Disabled by default;
 * enable with AIFROST_CAPTURE_DIR=<dir> (or `1`/`true` for state/captures).
 *
 * Contents are assistant-side capture text only — never cookies, credentials,
 * or request bodies. Capped at MAX_FILES_PER_AGENT per agent directory.
 */

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES_PER_AGENT = 20;
const MAX_FIELD_CHARS = 65_536;

export function captureDumpDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.AIFROST_CAPTURE_DIR;
  if (!v || v === "0" || v === "false") return null;
  if (v === "1" || v === "true") return path.join("state", "captures");
  return v;
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function clip(s: unknown): unknown {
  return typeof s === "string" && s.length > MAX_FIELD_CHARS
    ? `${s.slice(0, MAX_FIELD_CHARS)}…[truncated ${s.length - MAX_FIELD_CHARS} chars]`
    : s;
}

export async function dumpGenerationCapture(record: {
  agentId: string;
  generationId: string;
  url?: string;
  /** Raw page-side capture buffer (network stream text before cleaning). */
  rawNetworkText?: string;
  /** Final emitted assistant text after echo/DOM cleaning. */
  emittedText?: string;
  pageError?: string | null;
}): Promise<void> {
  const root = captureDumpDir();
  if (!root) return;
  const agentDir = path.join(root, safeSegment(record.agentId));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(agentDir, `${stamp}-${safeSegment(record.generationId)}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        agentId: record.agentId,
        generationId: record.generationId,
        url: record.url,
        rawNetworkText: clip(record.rawNetworkText ?? ""),
        emittedText: clip(record.emittedText ?? ""),
        pageError: clip(record.pageError ?? null),
      },
      null,
      2,
    ),
  );

  // Prune oldest files beyond the cap (names sort chronologically).
  const files = (await readdir(agentDir)).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_FILES_PER_AGENT))) {
    await unlink(path.join(agentDir, f)).catch(() => {});
  }
}
