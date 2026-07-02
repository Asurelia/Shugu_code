// Tests du journal de notifications (store TanStack observable).

import { describe, it, expect, beforeEach } from "vitest";
import { queryClient } from "@/lib/queryClient";
import {
  recordNotification,
  markAllNotificationsRead,
  clearNotifications,
  formatRelativeTime,
  MAX_NOTIFICATIONS,
  type AppNotification,
} from "./notifications";

const KEY = ["ui", "notifications"] as const;

function read(): AppNotification[] {
  return queryClient.getQueryData<AppNotification[]>(KEY) ?? [];
}

beforeEach(() => {
  clearNotifications();
});

describe("recordNotification", () => {
  it("préprend les notifications (plus récente en tête), non lues", () => {
    recordNotification("première", "info", 1000);
    recordNotification("seconde", "error", 2000);
    const all = read();
    expect(all.map((n) => n.message)).toEqual(["seconde", "première"]);
    expect(all.every((n) => !n.read)).toBe(true);
    expect(all[0].kind).toBe("error");
  });

  it("borne le journal à MAX_NOTIFICATIONS", () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 10; i++) {
      recordNotification(`n${i}`, "info", i);
    }
    const all = read();
    expect(all).toHaveLength(MAX_NOTIFICATIONS);
    // Les plus anciennes sont sorties, la plus récente est en tête.
    expect(all[0].message).toBe(`n${MAX_NOTIFICATIONS + 9}`);
  });

  it("génère des ids uniques même à timestamp identique", () => {
    const a = recordNotification("a", "info", 5000);
    const b = recordNotification("b", "info", 5000);
    expect(a).not.toBe(b);
  });
});

describe("markAllNotificationsRead / clearNotifications", () => {
  it("passe tout en lu sans perdre d'entrées", () => {
    recordNotification("x", "info", 1);
    recordNotification("y", "success", 2);
    markAllNotificationsRead();
    const all = read();
    expect(all).toHaveLength(2);
    expect(all.every((n) => n.read)).toBe(true);
  });

  it("clear vide le journal", () => {
    recordNotification("x");
    clearNotifications();
    expect(read()).toHaveLength(0);
  });
});

describe("formatRelativeTime", () => {
  const now = 10 * 24 * 60 * 60 * 1000; // t₀ arbitraire

  it("échelles : instant → min → h → hier → jours", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("à l'instant");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("il y a 5 min");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("il y a 3 h");
    expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe("hier");
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe("il y a 4 j");
  });

  it("un ts futur (horloge décalée) ne produit pas de valeur négative", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("à l'instant");
  });
});
