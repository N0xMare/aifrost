import { describe, expect, it } from "vitest";
import {
  extractProjectGizmoId,
  projectConversationUrl,
  projectHomeUrl,
  resolveChatGptProjectName,
} from "../../src/providers/chatgpt-web/projects.js";

describe("resolveChatGptProjectName", () => {
  it("defaults to aifrost", () => {
    expect(resolveChatGptProjectName({})).toBe("aifrost");
  });

  it("disables with none/off", () => {
    expect(resolveChatGptProjectName({ AIFROST_CHATGPT_PROJECT: "none" })).toBe(null);
    expect(resolveChatGptProjectName({ AIFROST_CHATGPT_PROJECT: "off" })).toBe(null);
  });

  it("honors custom name", () => {
    expect(resolveChatGptProjectName({ AIFROST_CHATGPT_PROJECT: "MyAgents" })).toBe("MyAgents");
  });
});

describe("project URLs", () => {
  it("builds home and conversation URLs", () => {
    expect(projectHomeUrl("g-p-abc123")).toBe("https://chatgpt.com/g/g-p-abc123/project");
    expect(projectConversationUrl("g-p-abc123", "conv-1", "aifrost")).toBe(
      "https://chatgpt.com/g/g-p-abc123-aifrost/c/conv-1",
    );
  });

  it("extracts gizmo id from href", () => {
    expect(
      extractProjectGizmoId("https://chatgpt.com/g/g-p-0000000000000000000000000000aa/project"),
    ).toBe("g-p-0000000000000000000000000000aa");
    expect(
      extractProjectGizmoId(
        "https://chatgpt.com/g/g-p-0000000000000000000000000000aa-aifrost/c/xyz",
      ),
    ).toBe("g-p-0000000000000000000000000000aa");
    expect(extractProjectGizmoId("https://chatgpt.com/")).toBeNull();
  });
});
