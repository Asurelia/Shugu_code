import { describe, expect, it } from "vitest";
import { updateProgressPercent } from "./updates";

describe("updateProgressPercent", () => {
  it("clamps malformed progress values", () => {
    expect(updateProgressPercent(null)).toBe(0);
    expect(updateProgressPercent({ received: 50, total: 100 })).toBe(50);
    expect(updateProgressPercent({ received: 200, total: 100 })).toBe(100);
    expect(updateProgressPercent({ received: -10, total: 100 })).toBe(0);
  });
});
