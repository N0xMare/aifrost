import { describe, expect, it } from "vitest";
import { diffSettings, settingsEqual } from "../../src/types/settings.js";

describe("settings", () => {
  it("diffs desired vs effective keys", () => {
    expect(
      diffSettings(
        { model_or_mode: "a", reasoning: { effort: "high" } },
        { model_or_mode: "b", reasoning: { effort: "high" } },
      ),
    ).toEqual(["model_or_mode"]);
  });

  it("settingsEqual ignores key order", () => {
    expect(settingsEqual({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(settingsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
