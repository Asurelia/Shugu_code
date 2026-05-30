// Shugu Forge — colored file-type icons for the explorer tree.
//
// A hand-made "Shugu version" of the VS Code / Seti file-icon idea: distinct,
// brand-coloured glyphs per file type, plus coloured folders with a handful of
// recognisable special folders. No external dependency — pure inline SVG in the
// same spirit as the stroke `Icon` atom, but FILLED + coloured so types pop on
// the dark Celestial Veil background.
//
// Two visual grammars, one language:
//   - BADGE  : a rounded square in the language's brand colour with a 1-2 char
//              monogram (TS, JS, PY, RS…). This is the instantly-recognisable
//              VS Code cue and stays crisp at any size (it's SVG <text>).
//   - GLYPH  : a real little drawing for the visually-iconic types (image,
//              padlock for lockfiles, braces for JSON, <> for HTML, the Git
//              mark, a folder…).
//
// Lookup order for files: exact filename (package.json, Dockerfile…) →
// extension → generic file. Folders: exact name (node_modules, .git…) → generic.

import React from "react";

// ── Palette (brand colours, tuned for a dark surface) ───────────────────────
const C = {
  ts: "#3178c6",
  react: "#61dafb",
  js: "#f0db4f",
  json: "#e8b339",
  rust: "#e0894f",
  py: "#5a9fd4",
  md: "#6aa9e0",
  css: "#42a5f5",
  scss: "#cf649a",
  html: "#e44d26",
  toml: "#c08457",
  yaml: "#d36b6b",
  shell: "#8bc34a",
  sql: "#f29111",
  xml: "#8bbf56",
  vue: "#41b883",
  svelte: "#ff3e00",
  go: "#00add8",
  java: "#e76f00",
  c: "#5c9bd5",
  cpp: "#6f9fd8",
  lock: "#9aa0a6",
  image: "#a874d8",
  svg: "#ffb13b",
  env: "#e8d44d",
  git: "#f14e32",
  npm: "#cb3837",
  docker: "#2496ed",
  archive: "#b58b5a",
  log: "#8a8f98",
  txt: "#b8bcc4",
  fileMuted: "#8b93a7",
  // Folders
  folder: "#8896d4", // generic — soft periwinkle, on-theme
  folderAccent: "#9d7cf0", // src / source folders — brighter Celestial purple
  folderMuted: "#6e7681", // node_modules / dist / build / target
  folderBlue: "#5aa9e6", // public / assets / docs
  folderGreen: "#89c34a", // scripts
  folderYellow: "#b8a13a", // tests
} as const;

type IconDesc =
  | { kind: "badge"; color: string; label: string; fg?: string }
  | { kind: "glyph"; render: (s: number) => React.ReactNode };

// ── Glyph builders (filled, coloured) ───────────────────────────────────────
function svg(size: number, children: React.ReactNode, extra?: React.CSSProperties) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flexShrink: 0, ...extra }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function badgeNode(size: number, color: string, label: string, fg = "#fff") {
  // Rounded square + centred monogram. Font size scales with label length so
  // 1-2 char labels stay balanced inside the 24-unit box.
  const fontSize = label.length >= 2 ? 9 : 12;
  return svg(
    size,
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="4" fill={color} />
      <text
        x="12"
        y="12.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
        fontSize={fontSize}
        fontWeight={700}
        fill={fg}
        letterSpacing={label.length >= 2 ? -0.5 : 0}
      >
        {label}
      </text>
    </>,
  );
}

// JSON — braces
function jsonGlyph(size: number) {
  return svg(
    size,
    <g stroke={C.json} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M8 4c-2 0-3 1-3 3v2c0 1.2-.7 2-2 2 1.3 0 2 .8 2 2v2c0 2 1 3 3 3" />
      <path d="M16 4c2 0 3 1 3 3v2c0 1.2.7 2 2 2-1.3 0-2 .8-2 2v2c0 2-1 3-3 3" />
    </g>,
  );
}

// HTML / XML-ish — angle brackets
function codeBracketsGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <g stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="m8.5 8-4 4 4 4" />
        <path d="m15.5 8 4 4-4 4" />
      </g>,
    );
}

// Markdown — the "M ↓" mark in a rounded rect
function mdGlyph(size: number) {
  return svg(
    size,
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="3" fill="none" stroke={C.md} strokeWidth="1.8" />
      <path
        d="M6 16V9.5l2.6 3 2.6-3V16"
        stroke={C.md}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M16 9.5V15m0 0 1.8-2M16 15l-1.8-2"
        stroke={C.md}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>,
  );
}

// Image — frame with sun + mountains
function imageGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="2.5" fill={color} opacity="0.18" />
        <rect
          x="3"
          y="4.5"
          width="18"
          height="15"
          rx="2.5"
          fill="none"
          stroke={color}
          strokeWidth="1.7"
        />
        <circle cx="8.5" cy="9.5" r="1.6" fill={color} />
        <path
          d="m4.5 18 4.5-5 3 3 3-3.5 4.5 5.5"
          fill="none"
          stroke={color}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>,
    );
}

// Lockfile — padlock
function lockGlyph(size: number) {
  return svg(
    size,
    <>
      <rect x="5" y="10.5" width="14" height="9" rx="2" fill={C.lock} opacity="0.22" />
      <rect
        x="5"
        y="10.5"
        width="14"
        height="9"
        rx="2"
        fill="none"
        stroke={C.lock}
        strokeWidth="1.8"
      />
      <path
        d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
        fill="none"
        stroke={C.lock}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="14.5" r="1.4" fill={C.lock} />
    </>,
  );
}

// Git — node + branch (the .gitignore / git family)
function gitGlyph(size: number) {
  return svg(
    size,
    <g stroke={C.git} strokeWidth="1.9" fill="none" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.2" fill={C.git} stroke="none" />
      <circle cx="6" cy="18" r="2.2" fill={C.git} stroke="none" />
      <circle cx="17" cy="11" r="2.2" fill={C.git} stroke="none" />
      <path d="M6 8.2v7.6" />
      <path d="M15.2 11.8 8 11.8a2 2 0 0 1-2-2" />
    </g>,
  );
}

// Config / env — gear
function gearGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <g fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4" />
      </g>,
    );
}

// npm / package — box with a notch
function npmGlyph(size: number) {
  return svg(
    size,
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" fill={C.npm} />
      <path d="M8 8h8v8h-3v-5h-2v5H8z" fill="#fff" />
    </>,
  );
}

// Docker — whale-ish stack
function dockerGlyph(size: number) {
  return svg(
    size,
    <g fill={C.docker}>
      <rect x="4" y="11" width="2.6" height="2.6" rx="0.4" />
      <rect x="7.2" y="11" width="2.6" height="2.6" rx="0.4" />
      <rect x="10.4" y="11" width="2.6" height="2.6" rx="0.4" />
      <rect x="7.2" y="7.8" width="2.6" height="2.6" rx="0.4" />
      <rect x="10.4" y="7.8" width="2.6" height="2.6" rx="0.4" />
      <path
        d="M3 14h12.5c2.8 0 4.5-1 5.2-2.6.3.9.3 2-.2 3-1 2-3.2 3.6-7 3.6C8.5 18 4.5 16.5 3 14Z"
        opacity="0.85"
      />
    </g>,
  );
}

// Archive — box
function archiveGlyph(size: number) {
  return svg(
    size,
    <>
      <rect x="4" y="6" width="16" height="13" rx="2" fill={C.archive} opacity="0.22" />
      <rect x="4" y="6" width="16" height="13" rx="2" fill="none" stroke={C.archive} strokeWidth="1.7" />
      <path d="M4 10h16" stroke={C.archive} strokeWidth="1.7" />
      <path d="M10.5 6v4M13.5 6v4" stroke={C.archive} strokeWidth="1.7" />
    </>,
  );
}

// Generic document — folded corner
function docGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <>
        <path
          d="M6 3h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
          fill={color}
          opacity="0.18"
        />
        <path
          d="M6 3h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
          fill="none"
          stroke={color}
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M13 3v5h5" fill="none" stroke={color} strokeWidth="1.7" strokeLinejoin="round" />
      </>,
    );
}

// txt / log — document with lines
function linesGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <>
        <path
          d="M6 3h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
          fill={color}
          opacity="0.16"
        />
        <path
          d="M6 3h7l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M13 3v5h5" fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        <path
          d="M7.5 12h7M7.5 15h7M7.5 18h4"
          stroke={color}
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </>,
    );
}

// Folder — filled, with an open variant
function folderGlyph(color: string) {
  return (size: number, open?: boolean) =>
    open
      ? svg(
          size,
          <>
            <path
              d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H7a2 2 0 0 0-1.9 1.4L3 18Z"
              fill={color}
              opacity="0.55"
            />
            <path
              d="M3 18 5.1 11.4A2 2 0 0 1 7 10h14l-2.3 7.2A2 2 0 0 1 16.8 18Z"
              fill={color}
            />
          </>,
        )
      : svg(
          size,
          <path
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
            fill={color}
          />,
        );
}

// ── File extension → icon descriptor ────────────────────────────────────────
const EXT: Record<string, IconDesc> = {
  ts: { kind: "badge", color: C.ts, label: "TS" },
  mts: { kind: "badge", color: C.ts, label: "TS" },
  cts: { kind: "badge", color: C.ts, label: "TS" },
  tsx: { kind: "glyph", render: reactGlyph(C.react) },
  jsx: { kind: "glyph", render: reactGlyph(C.react) },
  js: { kind: "badge", color: C.js, label: "JS", fg: "#1a1a1a" },
  mjs: { kind: "badge", color: C.js, label: "JS", fg: "#1a1a1a" },
  cjs: { kind: "badge", color: C.js, label: "JS", fg: "#1a1a1a" },
  json: { kind: "glyph", render: jsonGlyph },
  jsonc: { kind: "glyph", render: jsonGlyph },
  rs: { kind: "badge", color: C.rust, label: "RS" },
  py: { kind: "badge", color: C.py, label: "PY" },
  pyi: { kind: "badge", color: C.py, label: "PY" },
  md: { kind: "glyph", render: mdGlyph },
  mdx: { kind: "glyph", render: mdGlyph },
  css: { kind: "badge", color: C.css, label: "#", fg: "#fff" },
  scss: { kind: "badge", color: C.scss, label: "#", fg: "#fff" },
  sass: { kind: "badge", color: C.scss, label: "#", fg: "#fff" },
  less: { kind: "badge", color: C.css, label: "#", fg: "#fff" },
  html: { kind: "glyph", render: codeBracketsGlyph(C.html) },
  htm: { kind: "glyph", render: codeBracketsGlyph(C.html) },
  xml: { kind: "glyph", render: codeBracketsGlyph(C.xml) },
  toml: { kind: "badge", color: C.toml, label: "TO" },
  yaml: { kind: "badge", color: C.yaml, label: "YA" },
  yml: { kind: "badge", color: C.yaml, label: "YA" },
  sh: { kind: "badge", color: C.shell, label: "SH", fg: "#1a1a1a" },
  bash: { kind: "badge", color: C.shell, label: "SH", fg: "#1a1a1a" },
  zsh: { kind: "badge", color: C.shell, label: "SH", fg: "#1a1a1a" },
  ps1: { kind: "badge", color: C.shell, label: "PS", fg: "#1a1a1a" },
  sql: { kind: "badge", color: C.sql, label: "DB", fg: "#1a1a1a" },
  vue: { kind: "badge", color: C.vue, label: "V", fg: "#fff" },
  svelte: { kind: "badge", color: C.svelte, label: "S", fg: "#fff" },
  go: { kind: "badge", color: C.go, label: "GO", fg: "#fff" },
  java: { kind: "badge", color: C.java, label: "JA", fg: "#fff" },
  kt: { kind: "badge", color: C.java, label: "KT", fg: "#fff" },
  c: { kind: "badge", color: C.c, label: "C", fg: "#fff" },
  h: { kind: "badge", color: C.c, label: "H", fg: "#fff" },
  cpp: { kind: "badge", color: C.cpp, label: "C+", fg: "#fff" },
  cc: { kind: "badge", color: C.cpp, label: "C+", fg: "#fff" },
  cxx: { kind: "badge", color: C.cpp, label: "C+", fg: "#fff" },
  hpp: { kind: "badge", color: C.cpp, label: "H+", fg: "#fff" },
  cs: { kind: "badge", color: C.vue, label: "C#", fg: "#fff" },
  rb: { kind: "badge", color: C.html, label: "RB", fg: "#fff" },
  php: { kind: "badge", color: C.cpp, label: "PH", fg: "#fff" },
  lua: { kind: "badge", color: C.ts, label: "LU", fg: "#fff" },
  svg: { kind: "glyph", render: imageGlyph(C.svg) },
  png: { kind: "glyph", render: imageGlyph(C.image) },
  jpg: { kind: "glyph", render: imageGlyph(C.image) },
  jpeg: { kind: "glyph", render: imageGlyph(C.image) },
  gif: { kind: "glyph", render: imageGlyph(C.image) },
  webp: { kind: "glyph", render: imageGlyph(C.image) },
  bmp: { kind: "glyph", render: imageGlyph(C.image) },
  ico: { kind: "glyph", render: imageGlyph(C.image) },
  avif: { kind: "glyph", render: imageGlyph(C.image) },
  tar: { kind: "glyph", render: archiveGlyph },
  zip: { kind: "glyph", render: archiveGlyph },
  gz: { kind: "glyph", render: archiveGlyph },
  rar: { kind: "glyph", render: archiveGlyph },
  "7z": { kind: "glyph", render: archiveGlyph },
  log: { kind: "glyph", render: linesGlyph(C.log) },
  txt: { kind: "glyph", render: linesGlyph(C.txt) },
  env: { kind: "glyph", render: gearGlyph(C.env) },
};

// React (tsx/jsx) — the atom mark
function reactGlyph(color: string) {
  return (size: number) =>
    svg(
      size,
      <g fill="none" stroke={color} strokeWidth="1.5">
        <circle cx="12" cy="12" r="1.8" fill={color} stroke="none" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" />
      </g>,
    );
}

// ── Exact filename → icon (wins over extension) ─────────────────────────────
const FILE: Record<string, IconDesc> = {
  "package.json": { kind: "glyph", render: npmGlyph },
  "package-lock.json": { kind: "glyph", render: lockGlyph },
  "pnpm-lock.yaml": { kind: "glyph", render: lockGlyph },
  "yarn.lock": { kind: "glyph", render: lockGlyph },
  "cargo.lock": { kind: "glyph", render: lockGlyph },
  "bun.lockb": { kind: "glyph", render: lockGlyph },
  "tsconfig.json": { kind: "badge", color: C.ts, label: "TS" },
  "tsconfig.node.json": { kind: "badge", color: C.ts, label: "TS" },
  "tsconfig.app.json": { kind: "badge", color: C.ts, label: "TS" },
  dockerfile: { kind: "glyph", render: dockerGlyph },
  "docker-compose.yml": { kind: "glyph", render: dockerGlyph },
  "docker-compose.yaml": { kind: "glyph", render: dockerGlyph },
  ".gitignore": { kind: "glyph", render: gitGlyph },
  ".gitattributes": { kind: "glyph", render: gitGlyph },
  ".gitmodules": { kind: "glyph", render: gitGlyph },
  ".npmrc": { kind: "glyph", render: gearGlyph(C.npm) },
  ".env": { kind: "glyph", render: gearGlyph(C.env) },
  ".env.example": { kind: "glyph", render: gearGlyph(C.env) },
  ".env.local": { kind: "glyph", render: gearGlyph(C.env) },
};

// ── Exact folder name → colour (wins over generic folder) ───────────────────
const FOLDER: Record<string, string> = {
  node_modules: C.folderMuted,
  ".git": C.git,
  src: C.folderAccent,
  "src-tauri": C.folderAccent,
  lib: C.folderAccent,
  app: C.folderAccent,
  components: C.folderAccent,
  dist: C.folderMuted,
  build: C.folderMuted,
  out: C.folderMuted,
  target: C.folderMuted,
  ".cache": C.folderMuted,
  ".turbo": C.folderMuted,
  ".next": C.folderMuted,
  public: C.folderBlue,
  assets: C.folderBlue,
  docs: C.folderBlue,
  static: C.folderBlue,
  scripts: C.folderGreen,
  bin: C.folderGreen,
  tests: C.folderYellow,
  test: C.folderYellow,
  __tests__: C.folderYellow,
  "test-fixtures": C.folderYellow,
  convex: "#e8543a",
  docker: C.docker,
  ".github": C.fileMuted,
  ".vscode": C.folderBlue,
  ".shugu": C.folderAccent,
  ".shugu-forge": C.folderAccent,
  vendor: C.folderMuted,
};

// ── Resolve a name to its descriptor ────────────────────────────────────────
function fileDescriptor(name: string): IconDesc {
  const lower = name.toLowerCase();
  if (FILE[lower]) return FILE[lower];
  // Dockerfile with no extension, or "Foo.dockerfile"
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) {
    return { kind: "glyph", render: dockerGlyph };
  }
  // Multi-dot lockfiles already covered; fall through to extension.
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (ext && EXT[ext]) return EXT[ext];
  return { kind: "glyph", render: docGlyph(C.fileMuted) };
}

// ── Public component ────────────────────────────────────────────────────────
/**
 * Colored file-type icon for the explorer tree. Folders render a coloured
 * folder (with an open variant + special-folder colours); files render a
 * brand-coloured badge or glyph based on filename/extension.
 */
export function FileTypeIcon({
  name,
  isDir,
  isOpen = false,
  size = 14,
}: {
  name: string;
  isDir?: boolean;
  isOpen?: boolean;
  size?: number;
}) {
  if (isDir) {
    const color = FOLDER[name.toLowerCase()] ?? C.folder;
    return folderGlyph(color)(size, isOpen) as React.ReactElement;
  }
  const d = fileDescriptor(name);
  if (d.kind === "badge") return badgeNode(size, d.color, d.label, d.fg);
  return d.render(size) as React.ReactElement;
}
