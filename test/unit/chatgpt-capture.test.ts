import { describe, expect, it } from "vitest";
import { stripUserEchoPrefix } from "../../src/providers/chatgpt-web/adapter.js";

describe("stripUserEchoPrefix", () => {
  it("removes user text glued to assistant", () => {
    expect(stripUserEchoPrefix("testYep — I’m here. Test received successfully.", "test")).toBe(
      "Yep — I’m here. Test received successfully.",
    );
  });

  it("leaves clean assistant alone", () => {
    expect(stripUserEchoPrefix("Going well—thanks for asking.", "how is your day?")).toBe(
      "Going well—thanks for asking.",
    );
  });

  it("empties pure echo", () => {
    expect(stripUserEchoPrefix("hello?", "hello?")).toBe("");
  });
});
