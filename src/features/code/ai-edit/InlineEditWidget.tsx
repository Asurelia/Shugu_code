// Shugu Forge — Lot 1 (Éditeur⇄AI) — widget inline (prompt Cmd+K + barre Accept/Reject).
//
// Mounté dans la vue /code (views-code.tsx). Lit la session via le cache
// TanStack (useAiEditSession) et pilote le contrôleur. Rendu en position:fixed
// ancré à la tête de sélection (coords capturées par la commande Cmd+K).
//
// Restauration du flag dirty : pendant le stream, setFileContents est court-
// circuité (cf. annotation aiEditStream) ; au Reject/Abort/erreur la transaction
// de restauration N'EST PAS annotée → onChange repasse dirty:true. Le widget
// remet alors dirty à sa valeur d'avant l'édit (wasDirty).

import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/routes/shell-context";
import {
  useAiEditSession,
  submitPrompt,
  cancelPrompt,
  acceptSession,
  rejectSession,
  abortSession,
  dismissSession,
  discardSession,
} from "./aiEditController";

function modeLabel(mode: string): string {
  if (mode === "fix") return "Correction";
  if (mode === "refactor") return "Refactor";
  return "Édition";
}

export function InlineEditWidget() {
  const session = useAiEditSession();
  const { editorViewRef, setFileContents, activeFile } = useShell();
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const restoreDirty = useCallback(
    (path: string | null, wasDirty: boolean) => {
      if (!path) return;
      setFileContents((c: any) => {
        const cur = c[path];
        if (!cur || cur.dirty === wasDirty) return c;
        return { ...c, [path]: { ...cur, dirty: wasDirty } };
      });
    },
    [setFileContents],
  );

  // Focus le champ à l'entrée en phase prompting.
  useEffect(() => {
    if (session.status === "prompting") {
      setInstruction("");
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [session.status]);

  // Raccourcis clavier globaux pendant streaming/preview (le focus n'est pas
  // dans le widget : l'éditeur est verrouillé). Capture phase pour pré-empter
  // les autres handlers (ex. close-compare sur Échap).
  useEffect(() => {
    if (session.status !== "preview" && session.status !== "streaming") return;
    const onKey = (e: KeyboardEvent) => {
      const v = editorViewRef?.current?.getView() ?? null;
      if (!v) return;
      if (session.status === "preview") {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          acceptSession(v);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          restoreDirty(session.path, rejectSession(v));
        }
      } else if (e.key === "Escape") {
        // streaming → Stop
        e.preventDefault();
        e.stopPropagation();
        restoreDirty(session.path, abortSession(v));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session.status, session.path, editorViewRef, restoreDirty]);

  // C2 — abandon de session sur changement de fichier (la view d'origine a été
  // démontée via key={activeFile}). On ne dispatch sur AUCUNE view : l'ancienne
  // est morte, la nouvelle concerne un autre fichier. discardSession stoppe le
  // backend + reset le cache.
  useEffect(() => {
    if (session.status !== "idle" && session.path && session.path !== activeFile) {
      discardSession();
    }
  }, [activeFile, session.status, session.path]);

  if (session.status === "idle") return null;
  // C2 — l'utilisateur a changé de fichier en cours de session : la view
  // d'origine est démontée (key={activeFile}), la session ne concerne plus le
  // fichier affiché. Ne rien rendre + abandonner (l'effet ci-dessus stoppe le
  // backend et reset le cache).
  if (session.path && session.path !== activeFile) return null;
  const view = editorViewRef?.current?.getView() ?? null;

  const anchor = session.anchor ?? { x: 80, y: 80 };
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.x, window.innerWidth - 440)),
    top: Math.max(8, Math.min(anchor.y, window.innerHeight - 140)),
  };

  // ── PROMPTING (Cmd+K) ───────────────────────────────────────────────
  if (session.status === "prompting") {
    const submit = () => {
      const text = instruction.trim();
      if (!text || !view) return;
      void submitPrompt(view, text);
    };
    return (
      <div className="ai-edit-widget" style={style}>
        <div className="ai-edit-row">
          <span className="ai-edit-spark">✦</span>
          <textarea
            ref={inputRef}
            className="ai-edit-input"
            rows={2}
            value={instruction}
            placeholder="Décris l'édition à faire…  (⏎ pour lancer · Échap pour annuler)"
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (view) cancelPrompt(view);
              }
            }}
          />
        </div>
        <div className="ai-edit-actions">
          <button className="ai-edit-btn primary" onClick={submit} disabled={!instruction.trim()}>
            Générer ⏎
          </button>
          <button className="ai-edit-btn" onClick={() => view && cancelPrompt(view)}>
            Annuler
          </button>
        </div>
      </div>
    );
  }

  // ── STREAMING ───────────────────────────────────────────────────────
  if (session.status === "streaming") {
    return (
      <div className="ai-edit-widget" style={style}>
        <div className="ai-edit-row">
          <span className="ai-edit-spinner" />
          <span className="ai-edit-label">{modeLabel(session.mode)} en cours…</span>
          <button
            className="ai-edit-btn"
            onClick={() => view && restoreDirty(session.path, abortSession(view))}
          >
            Stop
          </button>
        </div>
      </div>
    );
  }

  // ── PREVIEW (diff affiché) ──────────────────────────────────────────
  if (session.status === "preview") {
    return (
      <div className="ai-edit-widget" style={style}>
        <div className="ai-edit-row">
          <span className="ai-edit-spark">✦</span>
          <span className="ai-edit-label">Revois le diff, puis :</span>
        </div>
        <div className="ai-edit-actions">
          <button className="ai-edit-btn primary" onClick={() => view && acceptSession(view)}>
            Accepter ⏎
          </button>
          <button
            className="ai-edit-btn"
            onClick={() => view && restoreDirty(session.path, rejectSession(view))}
          >
            Rejeter ⎋
          </button>
        </div>
      </div>
    );
  }

  // ── ERROR ───────────────────────────────────────────────────────────
  if (session.status === "error") {
    return (
      <div className="ai-edit-widget error" style={style}>
        <div className="ai-edit-row">
          <span className="ai-edit-label">⚠ {session.error}</span>
        </div>
        <div className="ai-edit-actions">
          <button
            className="ai-edit-btn"
            onClick={() => restoreDirty(session.path, dismissSession())}
          >
            Fermer
          </button>
        </div>
      </div>
    );
  }

  return null;
}
