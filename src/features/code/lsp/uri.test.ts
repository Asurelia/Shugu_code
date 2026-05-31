import { describe, it, expect } from "vitest";
import { fileUriForPath, relativePathFromUri } from "./uri";

describe("lsp uri conversions", () => {
  const ws = "file:///F:/Dev/shugu_code";

  it("builds a file URI from workspace + relative path", () => {
    expect(fileUriForPath(ws, "src/lib/fs.ts")).toBe("file:///F:/Dev/shugu_code/src/lib/fs.ts");
  });

  it("encodes spaces and accents in the relative path", () => {
    expect(fileUriForPath(ws, "src/Jean Côté.ts")).toBe(
      "file:///F:/Dev/shugu_code/src/Jean%20C%C3%B4t%C3%A9.ts",
    );
  });

  it("round-trips uri → relative path", () => {
    const uri = fileUriForPath(ws, "src/lib/fs.ts");
    expect(relativePathFromUri(ws, uri)).toBe("src/lib/fs.ts");
  });

  it("decodes percent-encoding on the way back", () => {
    const uri = fileUriForPath(ws, "src/Jean Côté.ts");
    expect(relativePathFromUri(ws, uri)).toBe("src/Jean Côté.ts");
  });

  it("returns null for a uri outside the workspace", () => {
    expect(relativePathFromUri(ws, "file:///C:/other/x.ts")).toBeNull();
  });

  it("matches the workspace prefix case-insensitively (Windows drive)", () => {
    // Le serveur peut renvoyer le drive en minuscule.
    expect(relativePathFromUri(ws, "file:///f:/Dev/shugu_code/src/a.ts")).toBe("src/a.ts");
  });
});
