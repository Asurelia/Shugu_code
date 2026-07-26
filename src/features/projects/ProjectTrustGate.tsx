import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { ConfirmDialog } from "@/components/trust";
import { pushToast } from "@/components/toast";
import { useModalFocusTrap } from "@/lib/modalFocus";
import { setProjectTrust } from "@/lib/projectTrust";
import {
  setProjectTrustCache,
  useProjectTrust,
} from "./projectTrustQueries";

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

export function ProjectTrustGate() {
  const { data: trust, isLoading } = useProjectTrust();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const readOnlyRef = useRef<HTMLButtonElement | null>(null);
  const open = !isLoading && Boolean(trust?.rootPath) && trust?.state === "unknown";

  useModalFocusTrap({
    open,
    containerRef: dialogRef,
    initialFocusRef: readOnlyRef,
    restoreFocus: false,
  });

  useEffect(() => {
    if (!open) return;
    const blockGlobalShortcuts = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", blockGlobalShortcuts, true);
    return () => document.removeEventListener("keydown", blockGlobalShortcuts, true);
  }, [open]);

  const decide = async (state: "readOnly" | "trusted") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await setProjectTrust(state, trust.rootPath);
      setProjectTrustCache(next);
      pushToast(
        state === "trusted"
          ? "Projet approuvé — règles et extensions projet activées."
          : "Projet ouvert en lecture seule — configuration projet désactivée.",
        "success",
        4500,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open || !trust?.rootPath) return null;

  return createPortal(
    <div className="project-trust-overlay">
      <div
        ref={dialogRef}
        className="project-trust-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-description"
        tabIndex={-1}
      >
        <div className="project-trust-icon" aria-hidden="true">
          <Icon name="shield" size={22} />
        </div>
        <div>
          <p className="project-trust-kicker">Confiance du projet</p>
          <h2 id="project-trust-title">Fais-tu confiance à « {basename(trust.rootPath)} » ?</h2>
        </div>
        <p id="project-trust-description" className="project-trust-description">
          Ce dossier peut contenir des instructions, hooks, skills, plugins et agents qui
          influencent Shugu ou lancent des commandes. Rien de cela ne sera activé sans ton accord.
        </p>
        <div className="project-trust-path-row">
          <code className="project-trust-path" title={trust.rootPath}>{trust.rootPath}</code>
          <button
            type="button"
            className="project-trust-copy"
            aria-label="Copier le chemin du projet"
            title="Copier le chemin"
            onClick={() => {
              void navigator.clipboard
                .writeText(trust.rootPath)
                .then(() => pushToast("Chemin copié.", "success", 1800))
                .catch((cause) => pushToast(`Copie impossible : ${String(cause)}`, "error", 4000));
            }}
          >
            <Icon name="copy" size={12} />
          </button>
        </div>
        <div className="project-trust-comparison">
          <div>
            <strong>Lecture seule</strong>
            <span>Fichiers consultables, automatisations et mutations agentiques bloquées.</span>
          </div>
          <div>
            <strong>Faire confiance</strong>
            <span>Active la configuration projet et les modes Auto/Full Access.</span>
          </div>
        </div>
        {(error || trust.verificationError) && (
          <p className="project-trust-error" role="alert" aria-live="assertive">
            {error ?? `Vérification native impossible : ${trust.verificationError}`}
          </p>
        )}
        <div className="project-trust-actions">
          <button
            ref={readOnlyRef}
            type="button"
            className="project-trust-readonly"
            disabled={busy}
            onClick={() => void decide("readOnly")}
          >
            Ouvrir en lecture seule
          </button>
          <button
            type="button"
            className="project-trust-approve"
            disabled={busy}
            onClick={() => void decide("trusted")}
          >
            <Icon name="shield" size={13} />
            {busy ? "Enregistrement…" : "Faire confiance"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectTrustBadge({ compact = false }: { compact?: boolean }) {
  const { data: trust } = useProjectTrust();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!trust?.rootPath || trust.state === "unknown") return null;

  const trusted = trust.state === "trusted";
  const label = trusted ? "Projet approuvé" : "Lecture seule";
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await setProjectTrust(
        trusted ? "readOnly" : "trusted",
        trust.rootPath,
      );
      setProjectTrustCache(next);
      setConfirmOpen(false);
      pushToast(
        trusted
          ? "Confiance révoquée — les prochains outils mutants seront bloqués."
          : "Projet approuvé.",
        "success",
        4000,
      );
    } catch (error) {
      pushToast(`Confiance projet : ${String(error)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`project-trust-badge ${trusted ? "is-trusted" : "is-readonly"}${compact ? " is-compact" : ""}`}
        onClick={() => setConfirmOpen(true)}
        title={`${label} — cliquer pour ${trusted ? "révoquer la confiance" : "approuver le projet"}`}
      >
        <Icon name={trusted ? "shield" : "lock"} size={compact ? 10 : 11} />
        {label}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={trusted ? "Révoquer la confiance de ce projet ?" : "Faire confiance à ce projet ?"}
        body={
          trusted
            ? "Les règles, hooks, skills, plugins et agents du projet seront désactivés. Tout run mutant actif sera interrompu avant son prochain outil."
            : "La configuration appartenant à ce dossier sera activée pour les prochains runs."
        }
        confirmLabel={busy ? "En cours…" : trusted ? "Révoquer" : "Faire confiance"}
        cancelLabel="Annuler"
        tone={trusted ? "danger" : "default"}
        busy={busy}
        onConfirm={() => void apply()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
