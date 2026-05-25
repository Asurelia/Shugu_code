// Shugu Forge — Studio conversation thread + composer (Phase F).
//
// The post-generation loop: a scrolling thread of turns (StudioTurnView) plus a
// chat composer to request adjustments. Each send becomes a new orchestrator
// turn that edits the existing project files (handled by the parent).

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import { StudioTurnView } from "./StudioTurnView";
import type { StudioTurn, SelectedElement } from "./studioChat";

export function StudioConversation({
  turns,
  busy,
  onSend,
  onNew,
  onSaveAs,
  onOpenFile,
  selectedElement,
  onClearSelected,
}: {
  turns: StudioTurn[];
  busy: boolean;
  onSend: (instruction: string) => void;
  onNew: () => void;
  onSaveAs?: () => void;
  onOpenFile?: (rel: string) => void;
  selectedElement?: SelectedElement | null;
  onClearSelected?: () => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest turn / activity in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, busy]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="studio-conv">
      <div className="studio-conv-head">
        <span className="studio-disco-label">Conversation</span>
        <span style={{ flex: 1 }} />
        {onSaveAs && (
          <button
            className="lgb lgb-sm"
            onClick={onSaveAs}
            disabled={busy || turns.length === 0}
            title="Sauvegarder une copie figée dans Projets"
          >
            <Icon name="copy" size={12} /> Sauvegarder
          </button>
        )}
        <button className="lgb lgb-sm" onClick={onNew} disabled={busy} title="Repartir d'un nouveau brief">
          <Icon name="plus" size={12} /> Nouveau
        </button>
      </div>

      <div className="studio-conv-thread scroll">
        {turns.length === 0 && (
          <div className="studio-conv-empty">
            <Icon name="sparkle" size={18} />
            <div className="studio-conv-empty-title">Projet existant chargé</div>
            <p>Demande un ajustement ci-dessous — ou « Nouveau » pour repartir d'un brief vierge.</p>
          </div>
        )}
        {turns.map((t) => (
          <StudioTurnView key={t.id} turn={t} onOpenFile={onOpenFile} />
        ))}
        <div ref={endRef} />
      </div>

      {selectedElement && (
        <div className="studio-sel-chip">
          <Icon name="sparkle" size={11} />
          <span>Élément ciblé : <code>{selectedElement.selector}</code></span>
          <button className="studio-sel-clear" onClick={onClearSelected} title="Annuler la sélection">
            <Icon name="x" size={11} />
          </button>
        </div>
      )}
      <div className="studio-conv-composer">
        <textarea
          className="studio-conv-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            selectedElement
              ? "Décris le changement pour l'élément ciblé…"
              : "Demande un ajustement — ex. « agrandis le hero », « palette plus sombre », « ajoute une section FAQ »…"
          }
          disabled={busy}
          rows={2}
        />
        <button
          className="lgb lgb-primary studio-conv-send"
          onClick={send}
          disabled={busy || !text.trim()}
          title="Envoyer"
        >
          {busy ? <span className="studio-ring" /> : <Icon name="send" size={13} />}
        </button>
      </div>
    </div>
  );
}
