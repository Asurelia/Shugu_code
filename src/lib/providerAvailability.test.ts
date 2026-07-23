import { describe, expect, it } from "vitest";
import { isLocalProviderEndpoint, providerAvailability } from "./providerAvailability";

describe("providerAvailability", () => {
  it("requires a key for remote OpenAI and Anthropic endpoints", () => {
    expect(providerAvailability("openai", "https://api.example.com", null)).toEqual({
      ready: false,
      reason: "clé API absente du coffre système",
    });
    expect(providerAvailability("anthropic", "https://api.anthropic.com", "secret").ready).toBe(true);
  });

  it("allows keyless local and subscription-backed providers", () => {
    expect(providerAvailability("openai", "http://localhost:8090", null).ready).toBe(true);
    expect(providerAvailability("ollama", "http://127.0.0.1:11434", null).ready).toBe(true);
    expect(providerAvailability("codex", "", null).ready).toBe(true);
  });

  it("recognizes only loopback HTTP endpoints as local", () => {
    expect(isLocalProviderEndpoint("http://127.0.0.1:8090/v1")).toBe(true);
    expect(isLocalProviderEndpoint("https://api.kimi.com/coding/v1")).toBe(false);
  });
});
