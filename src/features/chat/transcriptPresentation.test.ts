import { describe, expect, it } from "vitest";
import {
  createTranscriptPreview,
  LONG_RESPONSE_CHAR_LIMIT,
  LONG_RESPONSE_LINE_LIMIT,
} from "./transcriptPresentation";

describe("createTranscriptPreview", () => {
  it("leaves ordinary responses untouched", () => {
    expect(createTranscriptPreview("Une réponse concise.")).toEqual({
      text: "Une réponse concise.",
      truncated: false,
      hiddenCharacters: 0,
      hiddenLines: 0,
    });
  });

  it("bounds a long response and reports the hidden content", () => {
    const text = Array.from(
      { length: LONG_RESPONSE_LINE_LIMIT + 20 },
      (_, index) => `Ligne ${index} ${"x".repeat(80)}`,
    ).join("\n");
    const preview = createTranscriptPreview(text);
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThan(text.length);
    expect(preview.hiddenCharacters).toBeGreaterThan(0);
    expect(preview.hiddenLines).toBeGreaterThan(0);
  });

  it("also bounds a single very long paragraph", () => {
    const text = "x".repeat(LONG_RESPONSE_CHAR_LIMIT + 2_000);
    const preview = createTranscriptPreview(text);
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(6_000);
  });
});
