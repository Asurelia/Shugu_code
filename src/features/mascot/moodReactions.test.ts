import { describe, it, expect } from "vitest";
import {
  reactionFor,
  isReactionActive,
  effectiveMood,
  type ActiveReaction,
  type MoodEvent,
} from "./moodReactions";

const ALL_EVENTS: MoodEvent[] = [
  "agent-start",
  "agent-complete",
  "agent-error",
  "edit-accept",
  "edit-reject",
  "edit-error",
  "chat-error",
];

describe("reactionFor", () => {
  it("maps events to the expected mood", () => {
    expect(reactionFor("agent-complete").mood).toBe("joy");
    expect(reactionFor("agent-start").mood).toBe("joy");
    expect(reactionFor("agent-error").mood).toBe("cry");
    expect(reactionFor("edit-accept").mood).toBe("smile");
    expect(reactionFor("edit-reject").mood).toBe("neutral");
    expect(reactionFor("edit-error").mood).toBe("cry");
    expect(reactionFor("chat-error").mood).toBe("cry");
  });

  it("gives every event a positive TTL", () => {
    for (const e of ALL_EVENTS) {
      expect(reactionFor(e).ttlMs).toBeGreaterThan(0);
    }
  });
});

describe("isReactionActive", () => {
  const r: ActiveReaction = { mood: "joy", firedAt: 1000, ttlMs: 3000 };
  it("null → inactive", () => expect(isReactionActive(null, 1000)).toBe(false));
  it("at firedAt → active", () => expect(isReactionActive(r, 1000)).toBe(true));
  it("within ttl → active", () => expect(isReactionActive(r, 3999)).toBe(true));
  it("at the expiry boundary → inactive", () => expect(isReactionActive(r, 4000)).toBe(false));
  it("after expiry → inactive", () => expect(isReactionActive(r, 9999)).toBe(false));
});

describe("effectiveMood", () => {
  const r: ActiveReaction = { mood: "smile", firedAt: 1000, ttlMs: 2000 };
  it("an active reaction overrides the base mood", () => {
    expect(effectiveMood("neutral", r, 1500)).toBe("smile");
  });
  it("an expired reaction falls back to the base mood", () => {
    expect(effectiveMood("neutral", r, 5000)).toBe("neutral");
  });
  it("no reaction → base mood", () => {
    expect(effectiveMood("sad", null, 1500)).toBe("sad");
  });
});
