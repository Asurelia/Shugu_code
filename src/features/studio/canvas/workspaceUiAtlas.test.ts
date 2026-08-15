import { describe, expect, it } from "vitest";
import {
  discoverRoutesFromSource,
  extractCssUiSpecimens,
  extractIconsFromTsSource,
  filterWorkspaceHtmlPaths,
  packIconsSheet,
} from "./workspaceUiAtlas";

describe("workspaceUiAtlas", () => {
  it("filters forge / deep noise from html paths", () => {
    const pages = filterWorkspaceHtmlPaths([
      "index.html",
      "dist/index.html",
      "public/about.html",
      ".shugu-forge/preview/index.html",
      "node_modules/foo/index.html",
      "a/b/c/d/e/deep.html",
    ]);
    expect(pages).toContain("index.html");
    expect(pages).toContain("dist/index.html");
    expect(pages).toContain("public/about.html");
    expect(pages.some((p) => p.includes("shugu-forge"))).toBe(false);
    expect(pages.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("extracts Icon() switch cases as SVG components", () => {
    const src = `
export function Icon({ name }) {
  const p = (d) => <svg>{d}</svg>;
  switch (name) {
    case "chat":   return p(<><path d="M21 12a8.5"/></>);
    case "code":   return p(<><path d="m9 18-6-6"/></>);
    default: return p(<circle cx="12" cy="12" r="6"/>);
  }
}`;
    const icons = extractIconsFromTsSource(src, "src/components/components.tsx");
    expect(icons.map((i) => i.name)).toEqual(["Icône · chat", "Icône · code"]);
    expect(icons[0].outerHtml).toContain("<svg");
    expect(icons[0].outerHtml).toContain("path");
  });

  it("builds button specimens when .lgb exists in CSS", () => {
    const specs = extractCssUiSpecimens(".lgb{padding:8px}.lgb-primary{color:red}.card{border:1px solid}");
    expect(specs.some((s) => s.id === "comp-kit-buttons")).toBe(true);
    expect(specs.some((s) => s.id === "comp-kit-cards")).toBe(true);
  });

  it("discovers router paths as pages", () => {
    const pages = discoverRoutesFromSource(`
      path: "/chat",
      path: "/code",
      path: "/studio/inspiration",
    `);
    expect(pages.map((p) => p.route)).toEqual(["route:chat", "route:code"]);
  });

  it("packs many icons into a single sheet component", () => {
    const icons = extractIconsFromTsSource(
      `switch(name){ case "a": return p(<><path d="M1"/></>); case "b": return p(<><path d="M2"/></>); }`,
      "x.tsx",
    );
    const sheet = packIconsSheet(icons);
    expect(sheet?.id).toBe("comp-icons-sheet");
    expect(sheet?.name).toMatch(/^Icônes/);
    expect(sheet?.outerHtml).toContain("data-shugu-component");
  });
});
