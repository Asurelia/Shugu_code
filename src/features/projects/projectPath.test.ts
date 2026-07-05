import { describe, it, expect } from "vitest";
import { normalizeRoot } from "@/lib/db";

// normalizeRoot is the project key normalizer (V18). It MUST produce the same
// key from two sources that store paths differently:
//   - fsGetWorkspaceRoot()  → already display form ("C:/Dev/proj")
//   - studio_projects.workspace_root → canonical Rust form ("\\?\C:\Dev\proj")
// If they diverge, the backfill would create duplicate/mismatched projects and
// conversations would land in the wrong bucket. This guards the recurring
// Windows `\\?\` extended-length-prefix bug.
describe("normalizeRoot", () => {
  it("strips the Windows \\\\?\\ extended-length prefix", () => {
    expect(normalizeRoot("\\\\?\\C:\\Dev\\shugu_code")).toBe("C:/Dev/shugu_code");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeRoot("C:\\Dev\\shugu_code")).toBe("C:/Dev/shugu_code");
  });

  it("drops a trailing slash", () => {
    expect(normalizeRoot("C:/Dev/shugu_code/")).toBe("C:/Dev/shugu_code");
    expect(normalizeRoot("C:\\Dev\\shugu_code\\")).toBe("C:/Dev/shugu_code");
  });

  it("is idempotent on an already-normalized display path", () => {
    const display = "C:/Dev/shugu_code";
    expect(normalizeRoot(display)).toBe(display);
    expect(normalizeRoot(normalizeRoot(display))).toBe(display);
  });

  it("maps the two source forms to the SAME key (the whole point)", () => {
    const fromWorkspaceRoot = normalizeRoot("C:/Dev/shugu_code");
    const fromStudioCanonical = normalizeRoot("\\\\?\\C:\\Dev\\shugu_code");
    expect(fromWorkspaceRoot).toBe(fromStudioCanonical);
  });

  // UNC network shares: Rust `strip_extended_prefix` collapses
  // `\\?\UNC\server\share` to `\\server\share`, which `norm_display` then emits
  // as `//server/share`. normalizeRoot MUST land on the same key from both the
  // studio (raw `\\?\UNC\...`) and workspace-root (already `//server/...`) forms.
  it("collapses the \\\\?\\UNC\\ prefix like the Rust side", () => {
    expect(normalizeRoot("\\\\?\\UNC\\server\\share\\proj")).toBe("//server/share/proj");
  });

  it("maps both UNC source forms to the SAME key", () => {
    const fromStudioCanonical = normalizeRoot("\\\\?\\UNC\\server\\share\\proj");
    const fromWorkspaceRoot = normalizeRoot("//server/share/proj");
    expect(fromWorkspaceRoot).toBe(fromStudioCanonical);
  });
});
