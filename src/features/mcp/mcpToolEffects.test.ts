import { describe, expect, it } from "vitest";
import { getMcpToolEffectMeta, type McpToolEffect } from "./mcpToolEffects";

describe("MCP tool effect presentation", () => {
  it("allows only explicit read effects in Auto", () => {
    const effects: McpToolEffect[] = [
      "sharedRead",
      "externalRead",
      "additiveWrite",
      "destructiveWrite",
      "unknown",
    ];

    expect(
      effects.filter((effect) => getMcpToolEffectMeta(effect).allowedInAuto),
    ).toEqual(["sharedRead", "externalRead"]);
  });

  it("fails closed for an unexpected effect value", () => {
    expect(
      getMcpToolEffectMeta("futureEffect" as McpToolEffect),
    ).toMatchObject({
      label: "effet inconnu",
      allowedInAuto: false,
    });
  });
});
