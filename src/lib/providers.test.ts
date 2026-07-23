import { describe, expect, it, vi } from "vitest";

import { resolveProvider } from "./providers";

describe("resolveProvider", () => {
  it("resolves a saved custom provider without a false warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveProvider("custom-1784812982217/k3")).toEqual({
      providerId: "custom-1784812982217",
      protocol: "custom",
      baseUrl: "",
      model: "k3",
    });
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
