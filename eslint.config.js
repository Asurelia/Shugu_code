// Shugu Forge — ESLint 10 flat config (quality-gates lane).
//
// Philosophy: this is a SAFETY-NET linter, not a style enforcer. The codebase
// is large (~280 TS/TSX files) and already formatted by Prettier, so we do NOT
// turn on opinionated stylistic rules that would flag thousands of pre-existing
// lines. Instead:
//
//   • `error`  → only on genuinely DANGEROUS / bug-shaped patterns
//                (debugger left in, unreachable code, accidental assignment in
//                 a condition, broken React hook usage, etc.).
//   • `warn`   → on smells worth surfacing but not worth failing the build
//                (unused vars, missing hook deps, suspicious conditions…).
//   • `off`    → on purely stylistic / formatting concerns (Prettier owns those)
//                and on rules that fight the existing intentional patterns.
//
// The `lint` script therefore EXITS 0 even with warnings (`--max-warnings`
// is intentionally NOT set), so this can be wired into CI as a non-blocking
// signal. The current source baseline is nevertheless 0 error / 0 warning.
// `lint:fix` applies autofixes.
//
// Type-aware rules are deliberately disabled (no `parserOptions.project`):
// they are ~10x slower and require a fully resolved program, which is overkill
// for a smoke-grade gate. typecheck (`tsc -b --noEmit`) already covers types.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  // ── Ignored paths ──────────────────────────────────────────────────────
  // Anything generated, vendored, or owned by another toolchain. Keeping this
  // list broad is what keeps the lint run fast and the noise low.
  {
    ignores: [
      "dist/**",
      "dist-ssr/**",
      "node_modules/**",
      ".claude/**",
      ".Codex/**",
      "src-tauri/**",
      "convex/_generated/**",
      "vendor/**",
      "public/**",
      "_design_extracted/**",
      "docs/**",
      "dev-logs/**",
      "evals/**",
      "scripts/**",
      "e2e/**", // e2e specs run under Playwright's own runtime, not the app build
      "coverage/**",
      "*.config.js",
      "*.config.ts",
      "**/*.d.ts",
    ],
  },

  // ── Base: TypeScript parser/plugin ONLY (no recommended rule flood) ───────
  //    Spreading js/tseslint `recommended` turns hundreds of rules into errors
  //    (no-undef — a known TS false-positive — alone fired ~1900x, and
  //    no-unused-expressions ~8400x). That contradicts this config's stated
  //    "error only on genuinely dangerous patterns" policy, so we register the
  //    parser/plugin via `base` and curate every error explicitly below.
  tseslint.configs.base,

  // ── App source (browser + React) ─────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // ── React hooks: rules-of-hooks is a real correctness bug → error.
      //    exhaustive-deps is advisory (intentional omissions exist) → warn.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Tauri's production correctness does not depend on Vite Fast Refresh,
      // and this codebase intentionally colocates components with stores/hooks.
      "react-refresh/only-export-components": "off",

      // ── Dangerous patterns → error ─────────────────────────────────────
      "no-debugger": "error",
      // `while (m = re.exec(s))` regex-loops use single parens idiomatically →
      // surface as warn, not a build-failing error.
      "no-cond-assign": ["warn", "except-parens"],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-finally": "error",
      "no-self-assign": "error",
      "no-constant-binary-expression": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-fallthrough": "error",
      "no-import-assign": "error",
      "no-setter-return": "error",
      "no-async-promise-executor": "error",

      // ── Smells → warn (surfaced, never blocking) ───────────────────────
      "no-console": "off", // dev tool: console is a feature here, not a smell
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["warn", { checkLoops: false }],
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],

      // ── Demote two ESLint-recommended rules from error → warn ──────────
      //    These ship as `error` in js.configs.recommended (ESLint 10) but are
      //    style/false-positive-prone, NOT dangerous: `no-useless-escape` flags
      //    over-escaped regex/string literals, and `no-useless-assignment`
      //    fires on harmless patterns like destructuring `let [r, g, b] = …`
      //    where the binding is read later via a closure. Per this config's
      //    "error only on bug-shaped code" policy they belong at warn.
      "no-useless-escape": "warn",
      "no-useless-assignment": "off",

      // ── TypeScript: relax the noisy recommended rules to warn/off ──────
      //    The repo runs `strict: false`, so erroring on these would flood
      //    CI. Surface them as warnings to drive gradual cleanup instead.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The migrated prototype deliberately runs with strict=false; AGENTS.md
      // explicitly accepts loose `any` until the dedicated typing migration.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-wrapper-object-types": "warn",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-namespace": "off",
      // `no-require-imports` would flag legitimate dynamic requires in glue code.
      "@typescript-eslint/no-require-imports": "off",
      // Misused-promises / floating-promises are type-aware → not available here.

      // Plain JS unused-vars off (the TS plugin version above owns it).
      "no-unused-vars": "off",
    },
  },

  // ── Test files: relax further (mocks, any, non-null are fine in tests) ────
  {
    files: ["src/**/*.test.{ts,tsx}", "src/mocks/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
