// Garde-fou de PARITÉ Rust ↔ TS (revue Lot B).
//
// `SUPPORTED_LANG_IDS` (client.ts) gate les appels LSP côté front ; il DOIT
// rester synchrone avec les langages que `resolve_lsp_binary` (lsp.rs) sait
// résoudre. Sinon : soit un langage gaté côté TS mais absent côté Rust (init
// qui échouera mystérieusement), soit un langage mappé côté Rust mais bloqué
// côté TS (code mort jamais atteint — le bug exact relevé en revue).
//
// On lit le SOURCE Rust (pas un build) et on vérifie que chaque langId TS
// apparaît bien dans un bras du match de resolve_lsp_binary. Test purement
// statique : aucune dépendance LSP/Tauri chargée.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SUPPORTED_LANG_IDS } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
// client.ts est dans src/features/code/lsp → remonter à la racine repo.
const repoRoot = resolve(here, "../../../..");
const lspRs = resolve(repoRoot, "src-tauri/src/commands/lsp.rs");

describe("LSP language parity (TS SUPPORTED_LANG_IDS ↔ Rust resolve_lsp_binary)", () => {
  const rustSource = readFileSync(lspRs, "utf8");

  it("every TS-supported langId is handled by resolve_lsp_binary in Rust", () => {
    // Les bras du match Rust ressemblent à :  "typescript" | "javascript" => (...)
    // On vérifie juste que le littéral "lang" apparaît dans le fichier (robuste
    // aux regroupements de bras). C'est une garde de présence, pas un parseur.
    const missing: string[] = [];
    for (const lang of SUPPORTED_LANG_IDS) {
      if (!rustSource.includes(`"${lang}"`)) missing.push(lang);
    }
    expect(missing, `langages gatés côté TS mais absents de resolve_lsp_binary: ${missing.join(", ")}`).toEqual([]);
  });

  it("SUPPORTED_LANG_IDS contient les 8 langages attendus (régression du désaccord en revue)", () => {
    expect([...SUPPORTED_LANG_IDS].sort()).toEqual(
      ["c", "cpp", "go", "java", "javascript", "python", "rust", "typescript"].sort(),
    );
  });
});
