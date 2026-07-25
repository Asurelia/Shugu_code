// Shugu Forge — P6.3 rewind par tour : action « Revenir ici » sur chaque
// message du fil (rangée d'actions du message, à côté de Copier).
//
// Trois choix (plan P6.3) :
//   - 📁 fichiers seuls    → preview + ConfirmDialog listant les fichiers, puis
//                            rewind gardé (checkpoint de secours + revert) ;
//   - 💬 conversation seule → fork (copie jusqu'au message, source intacte) +
//                            navigation vers la branche ;
//   - 🔀 les deux           → fork puis rewind fichiers (kind "both").
//
// Garde-fous : les modes fichiers passent TOUJOURS par la boîte de
// confirmation (fichiers restaurés/supprimés listés — y compris les
// changements utilisateur post-checkpoint) ; le backend prend un checkpoint
// de secours avant le revert (rewind réversible) ; un checkpoint absent
// (run Plan/lecture seule) est refusé proprement avec un toast d'erreur.
//
// Le bouton « Annuler ↺ » global de ChatWritesCard reste tel quel (cas
// particulier de rewind fichiers, limité aux écritures d'un message).

import { useState } from "react";
import { ConfirmDialog } from "@/components/trust/ConfirmDialog";
import { pushToast } from "@/components/toast";
import { Icon } from "@/components/components";
import type { Message } from "@/lib/types";
import {
  forkConversationAt,
  snapshotPreview,
  snapshotRewind,
  type SnapshotPreview,
} from "@/lib/rewind";
import {
  rewindChoicesFor,
  rewindConfirmContent,
  rewindResultSummary,
  type RewindChoice,
} from "./rewind";
import { useActiveConv } from "./chat-sync";

const CHOICE_LABELS: Record<RewindChoice, { icon: string; label: string; hint: string }> = {
  files: {
    icon: "📁",
    label: "Fichiers seuls",
    hint: "Restaure le workspace au checkpoint de ce tour (réversible).",
  },
  conversation: {
    icon: "💬",
    label: "Conversation seule",
    hint: "Crée une branche copiée jusqu'à ce message ; la source est conservée.",
  },
  both: {
    icon: "🔀",
    label: "Les deux",
    hint: "Restaure les fichiers ET crée la branche de conversation.",
  },
};

async function emitWorkspaceChanged(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/event");
    await mod.emit("workspace://changed", {});
  } catch (err) {
    console.warn("[rewind] workspace://changed emit failed:", err);
  }
}

export function RewindControl({ m, convId }: { m: Message; convId: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<{
    choice: RewindChoice;
    preview: SnapshotPreview | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setActiveConv] = useActiveConv();

  const choices = rewindChoicesFor(m);
  const agentId = typeof m.agentId === "string" ? m.agentId : null;

  const pick = (choice: RewindChoice) => {
    setMenuOpen(false);
    if (choice === "conversation") {
      setPending({ choice, preview: null });
      return;
    }
    // Modes fichiers : le preview alimente la boîte de confirmation ; un
    // checkpoint absent (run Plan / lecture seule / nettoyé) est refusé ici.
    if (!agentId) return;
    setBusy(true);
    void snapshotPreview(agentId)
      .then((preview) => setPending({ choice, preview }))
      .catch((err) =>
        pushToast(
          `Rewind impossible : ${String(err)} (ce tour n'a pas de checkpoint — mode lecture seule ?)`,
          "error",
          6000,
        ),
      )
      .finally(() => setBusy(false));
  };

  const confirm = () => {
    if (!pending) return;
    const { choice } = pending;
    setBusy(true);
    void (async () => {
      try {
        if (choice === "conversation") {
          const fork = await forkConversationAt(convId, String(m.id));
          setActiveConv(fork.conversationId);
          pushToast(
            `Branche créée — ${fork.copiedMessages} message(s) copié(s). La source est conservée.`,
            "success",
            5000,
          );
        } else if (choice === "files" && agentId) {
          const result = await snapshotRewind(agentId, "files");
          await emitWorkspaceChanged();
          pushToast(
            rewindResultSummary(result.restored.length, result.removed.length, result.safetyRef),
            result.safetyRef ? "success" : "info",
            7000,
          );
        } else if (choice === "both" && agentId) {
          // Fork D'ABORD (l'id de branche voyage dans l'event rewind du run),
          // puis rewind fichiers.
          const fork = await forkConversationAt(convId, String(m.id));
          const result = await snapshotRewind(agentId, "both", fork.conversationId);
          await emitWorkspaceChanged();
          setActiveConv(fork.conversationId);
          pushToast(
            `Branche créée + ${rewindResultSummary(result.restored.length, result.removed.length, result.safetyRef)}`,
            result.safetyRef ? "success" : "info",
            8000,
          );
        }
        setPending(null);
      } catch (err) {
        pushToast(`Rewind échoué : ${String(err)}`, "error", 7000);
      } finally {
        setBusy(false);
      }
    })();
  };

  const confirmContent = pending ? rewindConfirmContent(pending.choice, pending.preview) : null;

  return (
    <>
      <span style={{ position: "relative", display: "inline-block" }}>
        <button
          title="Revenir ici (fichiers et/ou conversation)"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
          <Icon name="revert" size={12} />
        </button>
        {menuOpen && (
          <span
            role="menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              right: 0,
              zIndex: 40,
              display: "flex",
              flexDirection: "column",
              minWidth: 210,
              background: "var(--surface-2, rgba(24,20,44,0.98))",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
              overflow: "hidden",
            }}
          >
            {choices.map((choice) => (
              <button
                key={choice}
                role="menuitem"
                title={CHOICE_LABELS[choice].hint}
                onClick={(e) => {
                  e.stopPropagation();
                  pick(choice);
                }}
                style={{
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  color: "var(--on-surface)",
                  textAlign: "left",
                  padding: "8px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {CHOICE_LABELS[choice].icon} {CHOICE_LABELS[choice].label}
                <span
                  style={{
                    display: "block",
                    fontSize: 10,
                    color: "var(--on-surface-muted)",
                    marginTop: 2,
                  }}
                >
                  {CHOICE_LABELS[choice].hint}
                </span>
              </button>
            ))}
          </span>
        )}
      </span>

      {confirmContent && (
        <ConfirmDialog
          open={pending != null}
          title={confirmContent.title}
          tone={confirmContent.danger ? "danger" : "default"}
          confirmLabel={busy ? "Rewind…" : confirmContent.confirmLabel}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {confirmContent.lines.map((line, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12,
                    fontFamily: line.startsWith("  ") ? "var(--font-mono)" : undefined,
                    color: line.startsWith("  ") ? "var(--on-surface-muted)" : undefined,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          }
          onCancel={() => setPending(null)}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
