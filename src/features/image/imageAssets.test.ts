import { describe, expect, it } from "vitest";
import { generationDisplaySrc } from "./imageAssets";

describe("generationDisplaySrc", () => {
  it("never asks WebView2 to load a known-missing local asset", () => {
    expect(generationDisplaySrc({ resultUrl: "C:\\missing\\asset.png", status: "missing" })).toBeNull();
  });

  it("preserves a present remote asset URL", () => {
    expect(generationDisplaySrc({ resultUrl: "https://example.com/a.png", status: "done" }))
      .toBe("https://example.com/a.png");
  });
});
