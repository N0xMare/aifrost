import { describe, expect, it } from "vitest";
import { startChromiumProcess } from "../../src/browser/chromium/process.js";

describe("chromium process personal-profile guard", () => {
  it("refuses default Brave Application Support path", async () => {
    await expect(
      startChromiumProcess({
        binaryPath: "/usr/bin/false",
        userDataDir: "/Users/x/Library/Application Support/BraveSoftware/Brave-Browser",
      }),
    ).rejects.toThrow(/Refusing to launch with personal browser profile/);
  });

  it("refuses default Chrome Application Support path", async () => {
    await expect(
      startChromiumProcess({
        binaryPath: "/usr/bin/false",
        userDataDir: "/Users/x/Library/Application Support/Google/Chrome",
      }),
    ).rejects.toThrow(/personal browser profile/);
  });

  it("allows aifrost state profile paths (not personal-profile error)", async () => {
    await expect(
      startChromiumProcess({
        binaryPath: "/nonexistent/brave-binary-for-test",
        userDataDir: "/tmp/aifrost-test-profile/chromium",
        readyTimeoutMs: 400,
      }),
    ).rejects.toThrow(/Chromium failed to become ready|ENOENT|spawn/);
  });
});
