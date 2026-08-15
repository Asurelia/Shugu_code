import { describe, expect, it } from "vitest";
import { createDefaultDoc } from "./studioCanvasDoc";
import {
  atlasVisualFingerprint,
  discoverPages,
  extractComponentsFromHtml,
  mergeProductAtlas,
  pageNodeId,
  wrapComponentPreview,
} from "./productAtlas";

describe("productAtlas", () => {
  it("discovers root HTML pages and sorts index first", () => {
    const pages = discoverPages(["pricing.html", "index.html", "about.html", "lib/x.js", "deep/a/b.html"]);
    expect(pages.map((p) => p.route)).toEqual(["index.html", "about.html", "pricing.html"]);
    expect(pageNodeId("index.html")).toBe("live-home");
    expect(pageNodeId("pricing.html")).toBe("page-pricing");
  });

  it("extracts data-shugu-component blocks preferentially", () => {
    const html = `
      <html><body>
        <section data-shugu-component="Hero">Hello hero content here</section>
        <div data-component="PricingCard" class="card">Price 9€ plan details</div>
        <section id="ignored-when-marked">Should not appear when marks exist</section>
      </body></html>`;
    const comps = extractComponentsFromHtml(html, "index.html");
    expect(comps.length).toBe(2);
    expect(comps[0].name).toBe("Hero");
    expect(comps[1].name).toBe("PricingCard");
    expect(comps[0].outerHtml).toContain("Hello hero");
  });

  it("falls back to sections/cards when unmarked", () => {
    const html = `
      <html><body>
        <section id="features">Feature one and two and three</section>
        <div class="card pricing-card">Starter plan card body</div>
      </body></html>`;
    const comps = extractComponentsFromHtml(html, "index.html");
    expect(comps.length).toBeGreaterThanOrEqual(2);
    expect(comps.some((c) => /features|card|pricing/i.test(c.name))).toBe(true);
  });

  it("mergeProductAtlas lays out pages + components and preserves brand/explorations", () => {
    let doc = createDefaultDoc();
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: "exp-manual",
          kind: "exploration",
          name: "Var",
          x: 2000,
          y: 40,
          width: 400,
          height: 300,
          zIndex: 50,
          html: "<p>x</p>",
        },
      ],
    };
    const next = mergeProductAtlas(doc, {
      pages: [
        { route: "index.html", name: "Page · Accueil" },
        { route: "pricing.html", name: "Page · Pricing" },
      ],
      components: [
        {
          id: "comp-index-hero",
          pageRoute: "index.html",
          name: "Hero",
          outerHtml: "<section>Hero block content</section>",
        },
      ],
      css: ":root{--x:1}",
    });
    expect(next.nodes.filter((n) => n.kind === "live")).toHaveLength(2);
    expect(next.nodes.filter((n) => n.kind === "component")).toHaveLength(1);
    expect(next.nodes.some((n) => n.id === "exp-manual")).toBe(true);
    expect(next.nodes.some((n) => n.kind === "brand")).toBe(true);
    const hero = next.nodes.find((n) => n.id === "comp-index-hero")!;
    expect(hero.html).toContain("Hero block");
    expect(hero.html).toContain("--x:1");
    expect(atlasVisualFingerprint(doc)).not.toBe(atlasVisualFingerprint(next));
  });

  it("wrapComponentPreview embeds CSS and markup", () => {
    const doc = wrapComponentPreview("<div class='c'>Hi there</div>", "body{color:red}", "Card");
    expect(doc).toContain("<title>Card</title>");
    expect(doc).toContain("body{color:red}");
    expect(doc).toContain("Hi there");
  });
});
