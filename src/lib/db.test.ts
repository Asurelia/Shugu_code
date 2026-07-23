import { describe, expect, it } from "vitest";
import { toGenerationRow } from "./db";

describe("toGenerationRow", () => {
  it("migre implicitement les anciennes créations vers image", () => {
    const row = toGenerationRow({
      id: 1,
      prompt: "mascotte",
      ratio: "1:1",
      hue: 240,
      ts: 123,
    });
    expect(row.kind).toBe("image");
  });

  it("préserve le type et le fichier d'un média non-image", () => {
    const row = toGenerationRow({
      id: "video-1",
      kind: "video",
      prompt: "panoramique",
      ratio: "16:9",
      hue: 260,
      ts: 456,
      resultUrl: "C:/media/video-1.mp4",
    });
    expect(row.kind).toBe("video");
    expect(row.result_url).toBe("C:/media/video-1.mp4");
  });
});
