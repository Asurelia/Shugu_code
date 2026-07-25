import { describe, it, expect } from "vitest";
import {
  parseFollowUpMode,
  inverseFollowUpMode,
  resolveEffectiveFollowUpMode,
  followUpModeIcon,
  followUpModeLabel,
  DEFAULT_FOLLOWUP_MODE,
} from "./followUpQueue";

describe("parseFollowUpMode", () => {
  it("retombe sur queue (défaut) quand la clé est absente ou invalide", () => {
    expect(parseFollowUpMode(undefined)).toBe(DEFAULT_FOLLOWUP_MODE);
    expect(parseFollowUpMode(null)).toBe(DEFAULT_FOLLOWUP_MODE);
    expect(parseFollowUpMode("")).toBe(DEFAULT_FOLLOWUP_MODE);
    expect(parseFollowUpMode("turbo")).toBe(DEFAULT_FOLLOWUP_MODE);
    expect(DEFAULT_FOLLOWUP_MODE).toBe("queue");
  });

  it("accepte les trois modes persistés", () => {
    expect(parseFollowUpMode("queue")).toBe("queue");
    expect(parseFollowUpMode("steer")).toBe("steer");
    expect(parseFollowUpMode("interrupt")).toBe("interrupt");
  });
});

describe("inverseFollowUpMode (Ctrl+Shift+Enter)", () => {
  it("inverse queue ↔ steer", () => {
    expect(inverseFollowUpMode("queue")).toBe("steer");
    expect(inverseFollowUpMode("steer")).toBe("queue");
  });

  it("interrupt reste interrupt", () => {
    expect(inverseFollowUpMode("interrupt")).toBe("interrupt");
  });

  it("deux inverses ramènent au mode de départ", () => {
    for (const m of ["queue", "steer", "interrupt"] as const) {
      expect(inverseFollowUpMode(inverseFollowUpMode(m))).toBe(m);
    }
  });
});

describe("resolveEffectiveFollowUpMode", () => {
  it("l'override one-shot gagne toujours sur le réglage", () => {
    expect(resolveEffectiveFollowUpMode("queue", "steer")).toBe("steer");
    expect(resolveEffectiveFollowUpMode("steer", "queue")).toBe("queue");
    expect(resolveEffectiveFollowUpMode("interrupt", "queue")).toBe("queue");
  });

  it("sans override, le réglage (parsé) s'applique", () => {
    expect(resolveEffectiveFollowUpMode("steer")).toBe("steer");
    expect(resolveEffectiveFollowUpMode("interrupt")).toBe("interrupt");
    expect(resolveEffectiveFollowUpMode("valeur-bizarre")).toBe("queue");
    expect(resolveEffectiveFollowUpMode(undefined)).toBe("queue");
  });
});

describe("présentation", () => {
  it("chaque mode a une icône et un libellé distincts", () => {
    const modes = ["queue", "steer", "interrupt"] as const;
    const icons = new Set(modes.map(followUpModeIcon));
    const labels = new Set(modes.map(followUpModeLabel));
    expect(icons.size).toBe(3);
    expect(labels.size).toBe(3);
  });
});
