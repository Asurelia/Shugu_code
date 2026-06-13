import { describe, it, expect } from "vitest";
import { safeHref } from "./markdownView";

describe("safeHref", () => {
  it("autorise http/https/mailto", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://x.io/y")).toBe("http://x.io/y");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  it("bloque javascript: / data: et autres schémas non sûrs", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("  JavaScript:alert(1)")).toBeNull();
    expect(safeHref("/relative/path")).toBeNull();
  });
});
