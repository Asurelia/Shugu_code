import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImageProvider } from "./imageProviders";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveImageProvider", () => {
  it("resolves known prefixed image providers", () => {
    expect(resolveImageProvider("minimax/image-01")).toMatchObject({
      providerId: "minimax",
      protocol: "minimax",
      model: "image-01",
    });
  });

  it("treats unknown prefixes as custom providers instead of silently falling back", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveImageProvider("my-endpoint/flux")).toMatchObject({
      providerId: "my-endpoint",
      protocol: "custom",
      baseUrl: "",
      model: "flux",
    });
  });

  it("keeps bare model names on the local ComfyUI path", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveImageProvider("my-local-checkpoint.safetensors")).toMatchObject({
      providerId: "comfyui",
      protocol: "comfyui",
      model: "my-local-checkpoint.safetensors",
    });
  });
});
