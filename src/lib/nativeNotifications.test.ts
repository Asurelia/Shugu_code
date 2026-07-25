import { describe, it, expect } from "vitest";
import {
  shouldNotify,
  parseNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
} from "./nativeNotifications";

describe("parseNotificationSettings", () => {
  it("défaut ON partout quand les clés sont absentes", () => {
    expect(
      parseNotificationSettings({
        runComplete: null,
        runError: undefined,
        hitlWaiting: null,
        onlyWhenUnfocused: undefined,
      }),
    ).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("seule la valeur explicite « false » coupe un toggle", () => {
    const s = parseNotificationSettings({
      runComplete: "false",
      runError: "true",
      hitlWaiting: "false",
      onlyWhenUnfocused: "false",
    });
    expect(s.runComplete).toBe(false);
    expect(s.runError).toBe(true);
    expect(s.hitlWaiting).toBe(false);
    expect(s.onlyWhenUnfocused).toBe(false);
  });
});

describe("shouldNotify", () => {
  const all = DEFAULT_NOTIFICATION_SETTINGS;

  it("chaque cas a son propre toggle", () => {
    expect(shouldNotify({ ...all, runComplete: false }, true, "runComplete")).toBe(false);
    expect(shouldNotify({ ...all, runError: false }, true, "runError")).toBe(false);
    expect(shouldNotify({ ...all, hitlWaiting: false }, true, "hitlWaiting")).toBe(false);
    // Les autres cas ne sont pas affectés.
    expect(shouldNotify({ ...all, runComplete: false }, false, "runError")).toBe(true);
  });

  it("« seulement si non focus » (défaut ON) supprime quand la fenêtre est focus", () => {
    expect(shouldNotify(all, true, "runComplete")).toBe(false);
    expect(shouldNotify(all, false, "runComplete")).toBe(true);
  });

  it("focus-only OFF ⇒ notifie même fenêtre focus", () => {
    const s = { ...all, onlyWhenUnfocused: false };
    expect(shouldNotify(s, true, "hitlWaiting")).toBe(true);
    expect(shouldNotify(s, false, "hitlWaiting")).toBe(true);
  });

  it("les deux gardes se composent (toggle OFF gagne toujours)", () => {
    const s = { ...all, onlyWhenUnfocused: false, runError: false };
    expect(shouldNotify(s, true, "runError")).toBe(false);
    expect(shouldNotify(s, true, "runComplete")).toBe(true);
  });
});
