// Vitest configuration — inherits from vite.config (plugins + alias).
//
// Why a separate file: vitest's UserConfig has a `test` field that vite's
// defineConfig doesn't type. mergeConfig from vitest/config combines both
// cleanly without polluting vite.config.ts.
//
// Environment: happy-dom — required for tests that import CodeMirror lang
// packages, which pull in @codemirror/view (DOM-aware at import time). Pure
// pure-Node tests (langFromPath) also work in happy-dom without overhead.

import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "happy-dom",
      globals: false,
      include: ["src/**/*.test.{ts,tsx}"],
      passWithNoTests: true,
    },
  }),
);
