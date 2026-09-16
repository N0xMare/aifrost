import { describe, it, expect } from "vitest";
import { RawCdpClient } from "../../src/browser/cdp/client.js";

describe("RawCdpClient", () => {
  it("rejects send when not connected", async () => {
    const c = new RawCdpClient();
    await expect(c.send({ method: "Browser.getVersion" })).rejects.toThrow(/not connected/);
  });

  it("close is idempotent", async () => {
    const c = new RawCdpClient();
    await c.close();
    await c.close();
    expect(c.connected).toBe(false);
  });
});
