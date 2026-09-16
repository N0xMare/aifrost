import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureDumpDir,
  dumpGenerationCapture,
} from "../../src/providers/chatgpt-web/capture-dump.js";

describe("capture-dump", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aifrost-capture-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is disabled without AIFROST_CAPTURE_DIR", () => {
    expect(captureDumpDir({})).toBeNull();
    expect(captureDumpDir({ AIFROST_CAPTURE_DIR: "0" })).toBeNull();
    expect(captureDumpDir({ AIFROST_CAPTURE_DIR: "1" })).toBe(path.join("state", "captures"));
    expect(captureDumpDir({ AIFROST_CAPTURE_DIR: "/tmp/x" })).toBe("/tmp/x");
  });

  it("writes a dump and prunes beyond the cap", async () => {
    process.env.AIFROST_CAPTURE_DIR = dir;
    try {
      for (let i = 0; i < 25; i++) {
        await dumpGenerationCapture({
          agentId: "agt_test",
          generationId: `gen_${String(i).padStart(2, "0")}`,
          url: "https://chatgpt.com/c/x",
          rawNetworkText: `payload ${i}`,
          emittedText: `answer ${i}`,
        });
        // Ensure distinct timestamps in filenames
        await new Promise((r) => setTimeout(r, 2));
      }
      const agentDir = path.join(dir, "agt_test");
      const files = await readdir(agentDir);
      expect(files.length).toBe(20);
      const contents = await Promise.all(
        files.map((f) => readFile(path.join(agentDir, f), "utf8")),
      );
      expect(contents.every((c) => c.includes("payload"))).toBe(true);
      expect(contents.some((c) => c.includes('"gen_00"'))).toBe(false);
      expect(contents.some((c) => c.includes('"gen_24"'))).toBe(true);
    } finally {
      delete process.env.AIFROST_CAPTURE_DIR;
    }
  });
});
