import { describe, expect, it } from "vitest";
import {
  executionProfileForMode,
  parseAgentAccessProfile,
} from "./chat-sync";

describe("agent execution profiles", () => {
  it("defaults invalid or missing session state to Auto", () => {
    expect(parseAgentAccessProfile(undefined)).toBe("auto");
    expect(parseAgentAccessProfile(null)).toBe("auto");
    expect(parseAgentAccessProfile("fullAccess")).toBe("fullAccess");
    expect(parseAgentAccessProfile("anything-else")).toBe("auto");
  });

  it("never lets access override Chat or Plan", () => {
    expect(executionProfileForMode("chat", "fullAccess")).toBe("chat");
    expect(executionProfileForMode("plan", "fullAccess")).toBe("plan");
  });

  it("maps Agent to the explicitly selected access profile", () => {
    expect(executionProfileForMode("agent", "auto")).toBe("auto");
    expect(executionProfileForMode("agent", "fullAccess")).toBe("fullAccess");
    expect(executionProfileForMode("goal", "auto")).toBe("auto");
    expect(executionProfileForMode("goal", "fullAccess")).toBe("fullAccess");
  });
});
