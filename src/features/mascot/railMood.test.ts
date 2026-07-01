import { describe, it, expect } from "vitest";
import { railMood, railStatus } from "./railMood";
import type { ActiveReaction } from "./moodReactions";

describe("railMood", () => {
  it("neutral quand rien ne se passe", () => {
    expect(railMood(null, false, 1000)).toBe("neutral");
  });

  it("joy quand un agent tourne (busy)", () => {
    expect(railMood(null, true, 1000)).toBe("joy");
  });

  it("une réaction non expirée prime sur la base", () => {
    const r: ActiveReaction = { mood: "cry", firedAt: 1000, ttlMs: 500 };
    // now-firedAt = 200 < 500 → réaction active
    expect(railMood(r, true, 1200)).toBe("cry");
  });

  it("une réaction expirée retombe sur la base", () => {
    const r: ActiveReaction = { mood: "cry", firedAt: 1000, ttlMs: 500 };
    // now-firedAt = 600 > 500 → expirée
    expect(railMood(r, true, 1600)).toBe("joy");
    expect(railMood(r, false, 1600)).toBe("neutral");
  });
});

describe("railStatus", () => {
  it("Shugu quand aucun agent", () => {
    expect(railStatus(0)).toBe("Shugu");
    expect(railStatus(-1)).toBe("Shugu");
  });

  it("accord singulier / pluriel", () => {
    expect(railStatus(1)).toBe("1 agent actif");
    expect(railStatus(3)).toBe("3 agents actifs");
  });
});
