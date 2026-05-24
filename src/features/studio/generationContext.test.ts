// Tests for buildGenerationContext — the pure assembler that turns the Studio
// assistant's inputs into the single `designContext` string. We cover the
// decisions that are easy to get wrong: system XOR direction exclusivity,
// discovery omission of empty dimensions, and the skill-catalogue budget cap.

import { describe, it, expect } from "vitest";
import { buildGenerationContext, type DiscoveryAnswers, type Direction } from "./generationContext";
import type { ActiveDesignSystem } from "@/features/design/activeDesignSystem";
import type { DesignSkillMeta } from "@/features/design/queries";

const SYSTEM: ActiveDesignSystem = {
  id: "acme",
  name: "Acme",
  designMd: "# Acme\nBold, geometric, high contrast.",
  tokensCss: ":root { --primary: #112233; }",
};

const DIRECTION: Direction = {
  id: "midnight",
  name: "Midnight Aurora",
  colors: [
    { name: "bg", oklch: "oklch(0.18 0.03 265)" },
    { name: "primary", oklch: "oklch(0.78 0.14 200)" },
  ],
  fonts: { display: "Space Grotesk", body: "Inter" },
};

const EMPTY_DISCOVERY: DiscoveryAnswers = {};

function mkSkills(n: number, descLen = 1): DesignSkillMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `skill-${i}`,
    name: `skill-${i}`,
    description: "lorem ipsum dolor ".repeat(descLen).trim(),
    category: "design-systems",
  }));
}

describe("buildGenerationContext", () => {
  it("emits the design-system section (and not a colour direction) when a system is active", () => {
    const out = buildGenerationContext({
      system: SYSTEM,
      skills: [],
      discovery: EMPTY_DISCOVERY,
      direction: null,
      brief: "a landing page",
    });
    expect(out).toContain("## DESIGN SYSTEM");
    expect(out).toContain("Acme");
    expect(out).not.toContain("## COLOUR DIRECTION");
  });

  it("emits the colour direction when no system is chosen", () => {
    const out = buildGenerationContext({
      system: null,
      skills: [],
      discovery: EMPTY_DISCOVERY,
      direction: DIRECTION,
      brief: "a landing page",
    });
    expect(out).toContain("## COLOUR DIRECTION");
    expect(out).toContain("Midnight Aurora");
    expect(out).toContain("oklch(0.78 0.14 200)");
    expect(out).not.toContain("## DESIGN SYSTEM");
  });

  it("prefers the system over a direction when both are supplied (mutual exclusivity)", () => {
    const out = buildGenerationContext({
      system: SYSTEM,
      skills: [],
      discovery: EMPTY_DISCOVERY,
      direction: DIRECTION,
      brief: "a landing page",
    });
    expect(out).toContain("## DESIGN SYSTEM");
    expect(out).not.toContain("## COLOUR DIRECTION");
  });

  it("includes only non-empty discovery dimensions", () => {
    const out = buildGenerationContext({
      system: null,
      skills: [],
      discovery: { palette: "Sombre", layout: "", mood: "Luxe" },
      direction: DIRECTION,
      brief: "a portfolio",
    });
    expect(out).toContain("## USER PREFERENCES (discovery)");
    expect(out).toContain("Palette: Sombre");
    expect(out).toContain("Mood: Luxe");
    expect(out).not.toContain("Layout:");
  });

  it("lists the whole skill catalogue when it fits the budget", () => {
    const skills = mkSkills(3);
    const out = buildGenerationContext({
      system: null,
      skills,
      discovery: EMPTY_DISCOVERY,
      direction: null,
      brief: "anything",
    });
    expect(out).toContain("## AVAILABLE DESIGN SKILLS");
    for (const s of skills) expect(out).toContain(s.name);
    expect(out).not.toContain("catalogue trimmed");
  });

  it("trims the skill catalogue by relevance and stays within budget when oversized", () => {
    const skills = mkSkills(200, 12); // ~200 entries with long descriptions
    const maxChars = 16000;
    const out = buildGenerationContext(
      { system: null, skills, discovery: EMPTY_DISCOVERY, direction: null, brief: "anything" },
      maxChars,
    );
    expect(out).toContain("catalogue trimmed");
    expect(out.length).toBeLessThanOrEqual(maxChars);
  });

  it("never exceeds maxChars even with a system + direction + discovery + skills", () => {
    const maxChars = 8000;
    const out = buildGenerationContext(
      {
        system: SYSTEM,
        skills: mkSkills(200, 12),
        discovery: { palette: "Sombre", mood: "Luxe", tone: "Élégant", constraints: "AA" },
        direction: DIRECTION,
        brief: "dashboard for developers",
      },
      maxChars,
    );
    expect(out.length).toBeLessThanOrEqual(maxChars);
  });

  it("returns an empty string when there is nothing to inject", () => {
    const out = buildGenerationContext({
      system: null,
      skills: [],
      discovery: EMPTY_DISCOVERY,
      direction: null,
      brief: "",
    });
    expect(out).toBe("");
  });
});
