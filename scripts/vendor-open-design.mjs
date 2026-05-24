// Shugu Forge — vendor open-design design systems + skills.
//
// Copies the framework-agnostic catalogue from nexu-io/open-design
// (Apache-2.0) into public/ so the webview can fetch it in dev (Vite) and
// prod (Tauri serves the bundled dist from its own origin):
//
//   public/design-systems/<id>/{DESIGN.md,components.html,tokens.css}
//   public/design-systems/index.json   (generated manifest)
//   public/design-skills/<id>/SKILL.md
//   public/design-skills/index.json     (generated manifest)
//
// We vendor a COPY (the user's call — these are portable text assets, not the
// 1 GB Next.js engine, which is mostly .git history + media). Attribution lives
// in THIRD_PARTY_NOTICES.md + vendor/open-design/LICENSE.
//
// Source: a sparse checkout of open-design. Refresh it with:
//   git clone --depth 1 --filter=blob:none --sparse \
//     https://github.com/nexu-io/open-design.git <dir>
//   git -C <dir> sparse-checkout set design-systems skills
// then run:  OD_SRC=<dir> node scripts/vendor-open-design.mjs
//
// Defaults OD_SRC to the temp clone used during planning.

import { existsSync, rmSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.OD_SRC || "C:/Users/rafai/AppData/Local/Temp/od-ds";

const srcDesign = join(SRC, "design-systems");
const srcSkills = join(SRC, "skills");

if (!existsSync(srcDesign) || !existsSync(srcSkills)) {
  console.error(`[vendor] source not found at ${SRC}.\nClone it first:\n  git clone --depth 1 --filter=blob:none --sparse https://github.com/nexu-io/open-design.git <dir>\n  git -C <dir> sparse-checkout set design-systems skills\nthen: OD_SRC=<dir> node scripts/vendor-open-design.mjs`);
  process.exit(1);
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Best-effort clean. On Windows a freshly-written tree can briefly hold a
// handle (indexer / AV), making rmSync throw EPERM. cpSync overwrites by
// default, so a failed clean only risks leaving removed-upstream entries —
// acceptable; don't abort the vendor over it.
const safeRm = (p) => {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (err) { console.warn(`[vendor] could not clean ${p} (${err.code}); overwriting in place`); }
};
const prettify = (id) =>
  id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Design systems ─────────────────────────────────────────────
function vendorDesignSystems() {
  const dest = join(ROOT, "public", "design-systems");
  safeRm(dest);
  mkdirSync(dest, { recursive: true });

  const manifest = [];
  for (const id of readdirSync(srcDesign).sort()) {
    const srcDir = join(srcDesign, id);
    if (!isDir(srcDir) || id.startsWith(".") || id.startsWith("_")) continue;
    const hasTokens = existsSync(join(srcDir, "tokens.css"));
    const hasComponents = existsSync(join(srcDir, "components.html"));
    const hasSpec = existsSync(join(srcDir, "DESIGN.md"));
    if (!hasTokens && !hasComponents && !hasSpec) continue;

    cpSync(srcDir, join(dest, id), { recursive: true });

    // Prefer the first H1 of DESIGN.md as the display name.
    let name = prettify(id);
    if (hasSpec) {
      const md = readFileSync(join(srcDir, "DESIGN.md"), "utf8");
      const h1 = md.match(/^#\s+(.+)$/m);
      if (h1) name = h1[1].trim();
    }
    manifest.push({ id, name, hasTokens, hasComponents, hasSpec });
  }
  writeFileSync(join(dest, "index.json"), JSON.stringify(manifest, null, 2));
  return manifest.length;
}

// ── Skills (frontmatter catalogue) ─────────────────────────────
// Line-based parse — robust to YAML block scalars (`description: |`) and the
// nested `od.category` mapping (a brittle single regex missed both).
function parseFrontmatter(src) {
  // CRLF-tolerant: git on Windows checks out text with \r\n, so a strict
  // `^---\n` fence never matched and the whole parse returned {}.
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dm = line.match(/^description:\s*(.*)$/);
    if (dm) {
      let val = dm[1].trim();
      if (val === "|" || val === ">" || val === "") {
        const buf = [];
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) buf.push(lines[j].trim());
        val = buf.join(" ");
      }
      out.description = unquote(val);
      continue;
    }
    const nm = line.match(/^name:\s*(.+)$/);
    if (nm) out.name = unquote(nm[1]);
    const cm = line.match(/^\s+category:\s*(.+)$/); // nested under od:
    if (cm && !out.category) out.category = unquote(cm[1]);
  }
  return out;
}

function vendorSkills() {
  const dest = join(ROOT, "public", "design-skills");
  safeRm(dest);
  mkdirSync(dest, { recursive: true });

  const manifest = [];
  for (const id of readdirSync(srcSkills).sort()) {
    const srcDir = join(srcSkills, id);
    if (!isDir(srcDir) || id.startsWith(".")) continue;
    const skillMd = join(srcDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    cpSync(srcDir, join(dest, id), { recursive: true });
    const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
    manifest.push({
      id,
      name: fm.name || prettify(id),
      description: fm.description || "",
      category: fm.category || "other",
    });
  }
  writeFileSync(join(dest, "index.json"), JSON.stringify(manifest, null, 2));
  return manifest.length;
}

const nDs = vendorDesignSystems();
const nSk = vendorSkills();
console.log(`[vendor] design-systems: ${nDs} → public/design-systems/`);
console.log(`[vendor] skills: ${nSk} → public/design-skills/`);
