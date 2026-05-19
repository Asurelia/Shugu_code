// LOT 1 — Unit tests for langFromPath.
//
// Pure function: extension/basename → langId. Table-driven covers every
// mapping in LANG_MAP plus edge cases (Dockerfile basename, uppercase
// extensions, unknown extensions, paths with directories).

import { describe, test, expect } from "vitest";
import { langFromPath } from "./fs";

describe("langFromPath", () => {
  const cases: Array<[string, string]> = [
    // TypeScript / JavaScript family
    ["foo.ts", "typescript"],
    ["foo.tsx", "typescript"],
    ["foo.js", "javascript"],
    ["foo.jsx", "javascript"],
    ["foo.mjs", "javascript"],
    ["foo.cjs", "javascript"],

    // Systems languages
    ["foo.rs", "rust"],
    ["foo.go", "go"],
    ["foo.java", "java"],
    ["foo.cpp", "cpp"],
    ["foo.cc", "cpp"],
    ["foo.cxx", "cpp"],
    ["foo.hpp", "cpp"],
    ["foo.c", "c"],
    ["foo.h", "c"],
    ["foo.cs", "csharp"],
    ["foo.kt", "kotlin"],
    ["foo.swift", "swift"],

    // Scripting
    ["foo.py", "python"],
    ["foo.rb", "ruby"],
    ["foo.php", "php"],
    ["foo.lua", "lua"],
    ["foo.sh", "shell"],
    ["foo.bash", "shell"],
    ["foo.zsh", "shell"],

    // Data / config
    ["foo.json", "json"],
    ["foo.jsonc", "json"],
    ["foo.yaml", "yaml"],
    ["foo.yml", "yaml"],
    ["foo.toml", "toml"],
    ["foo.xml", "xml"],
    ["foo.sql", "sql"],

    // Web
    ["foo.html", "html"],
    ["foo.htm", "html"],
    ["foo.css", "css"],
    ["foo.scss", "css"],
    ["foo.vue", "vue"],
    ["foo.svelte", "svelte"],

    // Docs
    ["foo.md", "markdown"],
    ["foo.mdx", "markdown"],

    // Paths with directories — extension extracted from last dot in basename
    ["src/lib/fs.ts", "typescript"],
    ["src/components/Button.tsx", "typescript"],
    ["a/b/c/d.rs", "rust"],

    // Dockerfile (basename match, no extension)
    ["Dockerfile", "dockerfile"],
    ["src/Dockerfile", "dockerfile"],
    ["docker/Dockerfile", "dockerfile"],
    // Dockerfile via `.dockerfile` extension
    ["build.dockerfile", "dockerfile"],
    ["src/staging.dockerfile", "dockerfile"],

    // Unknown / no extension → "text"
    ["foo.unknown", "text"],
    ["Makefile", "text"],
    ["LICENSE", "text"],
    ["README", "text"],
    ["foo", "text"],

    // Case sensitivity — extensions lowercased via .toLowerCase()
    ["FOO.TS", "typescript"],
    ["App.YAML", "yaml"],
    ["page.HTM", "html"],
    ["style.SCSS", "css"],
    ["Component.VUE", "vue"],
  ];

  test.each(cases)("'%s' -> %s", (path, expected) => {
    expect(langFromPath(path)).toBe(expected);
  });
});
