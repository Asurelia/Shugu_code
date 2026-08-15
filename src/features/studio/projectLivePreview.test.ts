import { describe, expect, it } from "vitest";
import { isSafeProjectPreviewUrl, workspaceDisplayName } from "./projectLivePreview";

describe("projectLivePreview", () => {
  it("only allows localhost http(s) URLs", () => {
    expect(isSafeProjectPreviewUrl("http://localhost:5173")).toBe(true);
    expect(isSafeProjectPreviewUrl("http://127.0.0.1:3000/app")).toBe(true);
    expect(isSafeProjectPreviewUrl("https://example.com")).toBe(false);
    expect(isSafeProjectPreviewUrl("preview://localhost/index.html")).toBe(false);
    expect(isSafeProjectPreviewUrl("not-a-url")).toBe(false);
  });

  it("derives display name from workspace path", () => {
    expect(workspaceDisplayName("F:/Dev/mon-app")).toBe("mon-app");
    expect(workspaceDisplayName(null)).toBe("Aucun projet");
  });
});
