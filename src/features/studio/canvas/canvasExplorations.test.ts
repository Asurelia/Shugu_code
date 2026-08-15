import { describe, expect, it } from "vitest";
import { createDefaultDoc } from "./studioCanvasDoc";
import {
  explorationNodeId,
  explorationsChanged,
  humanizeSlug,
  mergeExplorationsIntoDoc,
  slugFromFileName,
  slugifyExploration,
  titleFromHtml,
} from "./canvasExplorations";

describe("canvasExplorations", () => {
  it("parses and slugifies exploration filenames safely", () => {
    expect(slugFromFileName("hero-dark.html")).toBe("hero-dark");
    expect(slugFromFileName("../evil.html")).toBeNull();
    expect(slugFromFileName("nope.txt")).toBeNull();
    expect(slugifyExploration("Hero Dark!!")).toBe("hero-dark");
    expect(slugifyExploration("")).toMatch(/^variant-/);
  });

  it("extracts <title> for display names", () => {
    expect(titleFromHtml("<html><head><title>  Alt Hero  </title></head></html>", "x")).toBe(
      "Alt Hero",
    );
    expect(titleFromHtml("<html></html>", "hero-dark")).toBe(humanizeSlug("hero-dark"));
  });

  it("merges new exploration files onto the default canvas", () => {
    const doc = createDefaultDoc();
    const next = mergeExplorationsIntoDoc(doc, [
      { slug: "alt-a", name: "Alt A", html: "<html><body>A</body></html>" },
    ]);
    const node = next.nodes.find((n) => n.id === explorationNodeId("alt-a"));
    expect(node?.kind).toBe("exploration");
    expect(node?.html).toContain("A");
    // Core live + brand preserved
    expect(next.nodes.some((n) => n.kind === "live")).toBe(true);
    expect(next.nodes.some((n) => n.kind === "brand")).toBe(true);
  });

  it("updates html in place and removes stale exp-* nodes", () => {
    let doc = mergeExplorationsIntoDoc(createDefaultDoc(), [
      { slug: "keep", name: "Keep", html: "<p>1</p>" },
      { slug: "gone", name: "Gone", html: "<p>x</p>" },
    ]);
    expect(doc.nodes.some((n) => n.id === explorationNodeId("gone"))).toBe(true);

    doc = mergeExplorationsIntoDoc(doc, [
      { slug: "keep", name: "Keep v2", html: "<p>2</p>" },
    ]);
    expect(doc.nodes.some((n) => n.id === explorationNodeId("gone"))).toBe(false);
    const keep = doc.nodes.find((n) => n.id === explorationNodeId("keep"))!;
    expect(keep.name).toBe("Keep v2");
    expect(keep.html).toContain("2");
  });

  it("explorationsChanged detects real content diffs only", () => {
    const a = createDefaultDoc();
    const b = mergeExplorationsIntoDoc(a, [
      { slug: "v", name: "V", html: "<html/>" },
    ]);
    expect(explorationsChanged(a, b)).toBe(true);
    expect(explorationsChanged(b, b)).toBe(false);
  });
});
