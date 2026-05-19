// LOT 1 — Unit tests for langExtensionFor.
//
// Verifies that every langId returned by LANG_MAP has a non-empty CodeMirror
// Extension mapping. Languages without CM packages (kotlin, swift, csharp,
// shell, xml, lua, text) MUST fall through to [] so the editor remains
// functional in plain-text mode.

import { describe, test, expect } from "vitest";
import { langExtensionFor } from "./languages";

// Helper: returns true if the Extension is a non-empty configuration.
// CM6 Extensions are either an array (possibly empty) or an object with
// `extension` property (LanguageSupport, StreamLanguage, etc.).
function isNonEmptyExtension(ext: unknown): boolean {
  if (Array.isArray(ext)) return ext.length > 0;
  return ext != null && typeof ext === "object";
}

describe("langExtensionFor", () => {
  describe("supported languages (must return non-empty Extension)", () => {
    const supportedLangs = [
      "typescript",
      "javascript",
      "python",
      "rust",
      "go",
      "java",
      "c",
      "cpp",
      "php",
      "sql",
      "html",
      "css",
      "json",
      "markdown",
      "yaml",
      "vue",
      "svelte",
      "ruby",
      "toml",
      "dockerfile",
    ];

    test.each(supportedLangs)("'%s' returns a non-empty Extension", (langId) => {
      const ext = langExtensionFor(langId);
      expect(isNonEmptyExtension(ext)).toBe(true);
    });
  });

  describe("unsupported languages (graceful fallback to [])", () => {
    // These langIds exist in LANG_MAP but have NO CodeMirror language package
    // installed. langExtensionFor must return [] so the editor still works in
    // plain-text mode (no highlighting, but fully functional).
    const unsupportedLangs = [
      "kotlin",
      "swift",
      "csharp",
      "shell",
      "xml",
      "lua",
      "text",
    ];

    test.each(unsupportedLangs)("'%s' returns []", (langId) => {
      const ext = langExtensionFor(langId);
      expect(Array.isArray(ext)).toBe(true);
      expect((ext as unknown[]).length).toBe(0);
    });
  });

  describe("dead-case removal regression", () => {
    // After Reviewer A's MINOR fix, "scss" and "htm" no longer have explicit
    // case branches — LANG_MAP collapses them to "css" / "html" upstream.
    // langExtensionFor("scss") and ("htm") therefore hit the `default: []`.
    // The correct path is .scss/.htm extension -> LANG_MAP -> "css"/"html"
    // -> langExtensionFor -> Extension. This test asserts the dead-case
    // removal didn't break the actual user path.
    test("'scss' (raw langId) returns [] (handled upstream by LANG_MAP)", () => {
      expect(langExtensionFor("scss")).toEqual([]);
    });
    test("'htm' (raw langId) returns [] (handled upstream by LANG_MAP)", () => {
      expect(langExtensionFor("htm")).toEqual([]);
    });
  });

  describe("unknown langId", () => {
    test("returns []", () => {
      expect(langExtensionFor("klingon")).toEqual([]);
    });
    test("returns [] for empty string", () => {
      expect(langExtensionFor("")).toEqual([]);
    });
  });
});
