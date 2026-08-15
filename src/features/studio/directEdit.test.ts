import { describe, expect, it } from "vitest";
import {
  buildElSliders,
  countOccurrences,
  escapeHtmlText,
  patchStyleInHtml,
  patchTextInHtml,
  sourcePathForNode,
  upsertInlineStyle,
} from "./directEdit";

describe("escapeHtmlText", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtmlText(`a & b <c> "d"`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
  });
});

describe("patchTextInHtml", () => {
  const html = `<!doctype html><html><body><h1>Bienvenue</h1><p>Hello world</p></body></html>`;

  it("replaces a unique text node", () => {
    const r = patchTextInHtml(html, "Hello world", "Bonjour monde");
    expect(r.ok).toBe(true);
    expect(r.html).toContain("<p>Bonjour monde</p>");
    expect(r.html).toContain("<h1>Bienvenue</h1>");
  });

  it("escapes the replacement text", () => {
    const r = patchTextInHtml(html, "Hello world", "Tom & Jerry <3");
    expect(r.ok).toBe(true);
    expect(r.html).toContain(">Tom &amp; Jerry &lt;3<");
  });

  it("matches escaped source against raw selection text", () => {
    const src = `<p>Tom &amp; Jerry</p>`;
    const r = patchTextInHtml(src, "Tom & Jerry", "Duo");
    expect(r.ok).toBe(true);
    expect(r.html).toBe("<p>Duo</p>");
  });

  it("refuses ambiguous matches", () => {
    const dup = `<p>Carte</p><p>Carte</p>`;
    const r = patchTextInHtml(dup, "Carte", "Card");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ambiguous");
  });

  it("refuses when the text is not a standalone text node", () => {
    const r = patchTextInHtml(html, "world", "monde");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-found");
  });

  it("rejects empty / unchanged edits", () => {
    expect(patchTextInHtml(html, "", "x").reason).toBe("empty");
    expect(patchTextInHtml(html, "Hello world", "Hello world").reason).toBe("empty");
  });
});

describe("upsertInlineStyle", () => {
  it("adds a style attribute when absent", () => {
    expect(upsertInlineStyle(`<div class="card">`, "border-radius", "12px")).toBe(
      `<div class="card" style="border-radius: 12px">`,
    );
  });

  it("appends to an existing style attribute", () => {
    expect(upsertInlineStyle(`<div style="color: red">`, "margin", "8px")).toBe(
      `<div style="color: red; margin: 8px">`,
    );
  });

  it("replaces an existing declaration", () => {
    expect(upsertInlineStyle(`<div style="color: red">`, "color", "blue")).toBe(
      `<div style="color: blue">`,
    );
  });

  it("preserves single-quoted style attributes", () => {
    expect(upsertInlineStyle(`<p style='gap: 4px'>`, "padding", "2px")).toBe(
      `<p style='gap: 4px; padding: 2px'>`,
    );
  });

  it("handles self-closing tags", () => {
    expect(upsertInlineStyle(`<img src="a.png"/>`, "width", "10px")).toBe(
      `<img src="a.png" style="width: 10px"/>`,
    );
  });

  it("rejects invalid inputs", () => {
    expect(upsertInlineStyle("not-a-tag", "color", "red")).toBeNull();
    expect(upsertInlineStyle(`<div>`, "bad prop", "red")).toBeNull();
    expect(upsertInlineStyle(`<div>`, "color", "")).toBeNull();
  });
});

describe("patchStyleInHtml", () => {
  it("patches the unique matching opening tag", () => {
    const html = `<section><div class="hero"><span>x</span></div></section>`;
    const r = patchStyleInHtml(html, `<div class="hero">`, "min-height", "80vh");
    expect(r.ok).toBe(true);
    expect(r.html).toContain(`<div class="hero" style="min-height: 80vh">`);
  });

  it("refuses when the tag is not unique", () => {
    const html = `<div class="card">a</div><div class="card">b</div>`;
    const r = patchStyleInHtml(html, `<div class="card">`, "padding", "4px");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ambiguous");
  });

  it("reports a missing tag", () => {
    const r = patchStyleInHtml(`<p>x</p>`, `<div class="nope">`, "padding", "4px");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-found");
  });
});

describe("sourcePathForNode", () => {
  it("keeps live routes workspace-relative (workspace page or forge silo)", () => {
    expect(sourcePathForNode({ kind: "live", route: "index.html" })).toBe("index.html");
    expect(
      sourcePathForNode({ kind: "live", route: ".shugu-forge/preview/index.html" }),
    ).toBe(".shugu-forge/preview/index.html");
  });

  it("keeps workspace routes at the workspace root", () => {
    expect(sourcePathForNode({ kind: "live", route: "public/landing.html" })).toBe(
      "public/landing.html",
    );
  });

  it("returns null for explorations without route and brand nodes", () => {
    expect(sourcePathForNode({ kind: "exploration", route: undefined })).toBeNull();
    expect(sourcePathForNode({ kind: "brand", route: undefined })).toBeNull();
  });

  it("maps disk-backed explorations to their html file", () => {
    expect(
      sourcePathForNode({
        kind: "exploration",
        route: ".shugu-forge/canvas/explorations/hero-dark.html",
      }),
    ).toBe(".shugu-forge/canvas/explorations/hero-dark.html");
  });
});

describe("buildElSliders", () => {
  it("keeps single-length props with sensible ranges, skips shorthands and colors", () => {
    const sliders = buildElSliders([
      { prop: "font-size", value: "18px" },
      { prop: "padding", value: "8px 16px" },
      { prop: "color", value: "rgb(1, 2, 3)" },
      { prop: "border-radius", value: "1rem" },
    ]);
    const props = sliders.map((s) => s.prop);
    expect(props).toEqual(["font-size", "border-radius"]);
    const fs = sliders[0];
    expect(fs.value).toBe(18);
    expect(fs.unit).toBe("px");
    expect(fs.max).toBeGreaterThanOrEqual(36);
    const br = sliders[1];
    expect(br.unit).toBe("rem");
    expect(br.step).toBe(0.05);
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});
