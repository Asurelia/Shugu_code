import { describe, expect, it } from "vitest";
import { domItemLabel, filterDomItems, type DomTreeItem } from "./domLayers";

const ITEMS: DomTreeItem[] = [
  { i: 0, depth: 0, tag: "body", suffix: "", text: "" },
  { i: 1, depth: 1, tag: "header", suffix: ".site-head", text: "" },
  { i: 2, depth: 2, tag: "h1", suffix: "#title", text: "Bienvenue" },
  { i: 3, depth: 1, tag: "main", suffix: "", text: "" },
];

describe("domItemLabel", () => {
  it("combines tag, suffix and a text snippet", () => {
    expect(domItemLabel(ITEMS[2])).toBe("h1#title — Bienvenue");
  });

  it("omits the text part when empty", () => {
    expect(domItemLabel(ITEMS[0])).toBe("body");
  });
});

describe("filterDomItems", () => {
  it("returns everything on an empty query", () => {
    expect(filterDomItems(ITEMS, "  ")).toHaveLength(4);
  });

  it("matches tag, suffix or text, case-insensitively", () => {
    expect(filterDomItems(ITEMS, "H1")).toHaveLength(1);
    expect(filterDomItems(ITEMS, "site-head")).toHaveLength(1);
    expect(filterDomItems(ITEMS, "bienvenue")).toHaveLength(1);
    expect(filterDomItems(ITEMS, "zzz")).toHaveLength(0);
  });
});
