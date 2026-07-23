import { describe, it, expect } from "vitest";
import { sanitizeLspHtml } from "./sanitize";

describe("sanitizeLspHtml", () => {
  it("strips <script> tags", () => {
    const out = sanitizeLspHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain("ok");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeLspHtml('<img src="x" onerror="alert(1)">');
    expect(out.toLowerCase()).not.toContain("onerror");
  });

  it("strips javascript: hrefs", () => {
    const out = sanitizeLspHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("strips mixed-case executable markup in the structural safety pass", () => {
    const out = sanitizeLspHtml(
      '<ScRiPt src="https://evil.invalid/x.js"></ScRiPt><a HREF="  vbscript:alert(1)" OnClick="alert(1)">x</a>',
    );
    expect(out.toLowerCase()).not.toContain("script");
    expect(out.toLowerCase()).not.toContain("vbscript:");
    expect(out.toLowerCase()).not.toContain("onclick");
  });

  it("keeps legitimate hover markup (code + safe link)", () => {
    const out = sanitizeLspHtml('<pre><code>fn main() {}</code></pre><a href="https://docs.rs">docs</a>');
    expect(out).toContain("fn main()");
    expect(out).toContain("https://docs.rs");
  });
});
