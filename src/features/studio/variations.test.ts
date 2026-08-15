import { describe, expect, it } from "vitest";
import { buildVariationTask, defaultVariations } from "./variations";

describe("defaultVariations", () => {
  it("produces three contrasting, uniquely-slugged directions", () => {
    const vs = defaultVariations("Mon Dashboard");
    expect(vs).toHaveLength(3);
    const slugs = vs.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs[0]).toBe("mon-dashboard-sombre");
    expect(vs.every((v) => v.direction.length > 0 && v.hints.length > 0)).toBe(true);
  });

  it("falls back to a safe slug on empty seeds", () => {
    const vs = defaultVariations("  ");
    expect(vs[0].slug).toMatch(/^variant-[a-z0-9]+-sombre$/);
  });
});

describe("buildVariationTask", () => {
  it("scopes the agent to one exploration deposit and forbids preview writes", () => {
    const [v] = defaultVariations("landing");
    const task = buildVariationTask("Une landing page SaaS", v);
    expect(task).toContain("Une landing page SaaS");
    expect(task).toContain("studio_deposit_exploration");
    expect(task).toContain(v.slug);
    expect(task).toContain(".shugu-forge/preview/");
    expect(task).toMatch(/interdit/i);
  });
});
