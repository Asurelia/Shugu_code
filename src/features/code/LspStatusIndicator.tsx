// Shugu Forge — indicateur de statut LSP dans la statusbar (Lot B §4).
//
// Montre l'état du LSP pour le langage du fichier actif. Clic = aide install
// (toast avec la commande exacte). Aucune installation automatique : on montre,
// l'utilisateur décide (modèle de sûreté « empêcher l'irréparable »).
import { langFromPath } from "@/lib/fs";
import { isLspSupported } from "./lsp/client";
import { useLspStatus, getLspError, type LspStatus } from "./lsp/lspStatusStore";
import { pushToast } from "@/components/toast";

// Commande d'installation par langage (affichée au clic quand "absent").
const INSTALL_HINT: Record<string, string> = {
  typescript: "pnpm add -D typescript-language-server",
  javascript: "pnpm add -D typescript-language-server",
  rust: "rustup component add rust-analyzer",
  python: "pip install python-lsp-server",
  go: "go install golang.org/x/tools/gopls@latest",
  c: "installer LLVM (clangd)",
  cpp: "installer LLVM (clangd)",
  java: "installer jdtls (Eclipse JDT Language Server)",
};

const LABEL: Record<LspStatus, (lang: string) => string> = {
  absent: (l) => `⚠ ${l} : non installé`,
  starting: (l) => `◐ ${l} : démarrage…`,
  ready: (l) => `● ${l} : prêt`,
  error: (l) => `✕ ${l} : erreur`,
};

const COLOR: Record<LspStatus, string> = {
  absent: "var(--on-surface-variant)",
  starting: "var(--warn)",
  ready: "var(--success)",
  error: "var(--error, #ff6a8a)",
};

export function LspStatusIndicator({ activeFile }: { activeFile: string | null }) {
  const langId = activeFile ? langFromPath(activeFile) : null;
  const status = useLspStatus(langId);

  // Pas de LSP pour cette langue (markdown, json…) → on n'affiche rien.
  if (!langId || !isLspSupported(langId)) return null;

  const onClick = () => {
    if (status === "absent") {
      const hint = INSTALL_HINT[langId] ?? "voir la doc du serveur LSP";
      pushToast(`Pour activer le LSP ${langId} : ${hint}`, "info", 8000);
    } else if (status === "error") {
      // Montre la VRAIE raison (ex. « Request timed out ») au lieu d'un message
      // générique — diagnostic visible sans DevTools.
      const detail = getLspError(langId);
      pushToast(
        detail
          ? `LSP ${langId} en erreur : ${detail} — rouvre le fichier pour relancer.`
          : `LSP ${langId} en erreur — rouvre le fichier pour relancer.`,
        "info",
        8000,
      );
    }
  };

  const clickable = status === "absent" || status === "error";

  return (
    <span
      className="item lsp-status"
      style={{ color: COLOR[status], cursor: clickable ? "pointer" : "default" }}
      onClick={clickable ? onClick : undefined}
      title={clickable ? "Cliquer pour l'aide d'installation / relance" : undefined}
    >
      {LABEL[status](langId)}
    </span>
  );
}
