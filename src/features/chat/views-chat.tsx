// Shugu Forge — Chat (Codex/Claude-Code agent layout) + Image views.
//
// Phase 1 of the design-delta lot: the chat surface is redesigned to the
// agent-style "cx" layout (no avatars, mono meta lines, inline code chips,
// "files modified" action card, context chips under the composer) recreated
// from the design handoff (chat5). All data stays wired to the existing
// LOCAL-FIRST layer: useMessages (SQLite), useChatStream (live deltas),
// sendChatMessage / useActiveModel (chat-sync). No mock replies.
//
// highlightRust returns JSX tokens (no innerHTML injection — XSS-safe).

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/components";
import { invoke } from "@/lib/tauri";
import { useChatStream } from "./useChatStream";
import { useMessages, sendChatMessage, useActiveModel, useChatMode } from "./chat-sync";
import { useEditorSelection } from "./editorSelectionStore";
import { PermissionBadge, ModeBadge } from "@/components/trust";
import { useChatToolActivity } from "./chatToolActivityStore";
import { CaptureButton } from "./CaptureButton";
import { ModeSelector } from "./ModeSelector";
import { ChatWritesCard } from "./ChatWritesCard";
import { db } from "@/lib/db";
import { ModelPicker } from "@/features/panels/panels";
import { revealAgent, killAgent, type AgentStatus } from "@/lib/agents";
import { extractWorktreeStatus, isWorktreeRunActive, type WorktreeStatus } from "@/lib/worktree";
import { useAgentDefs } from "@/features/agents/agentDefsQueries";
import { useMessageDisplay, type AgentActivityItem } from "./useMessageDisplay";
import { useAgentTranscript } from "@/features/agents/queries";
import { BrowserTestResultViewer } from "./BrowserTestResultViewer";
import { CommandRiskCard } from "./CommandRiskCard";
import { AgentPlan } from "./AgentPlan";
import { QuickOpenPalette } from "@/features/code/QuickOpenPalette";
import { useChatMentionRequests, clearChatMentionRequests } from "./chatMentionStore";
import { Markdown } from "./markdownView";
import { useShell } from "@/routes/shell-context";
import { detectBlockPath } from "@/lib/markdown";
import { CodeMirrorEditor } from "@/features/code/CodeMirrorEditor";
import { GitDiffView } from "@/features/code/DiffView";
import { ContextBubble } from "@/features/context-cards/ContextBubble";
import { loadProviderConfig } from "@/lib/credentials";
import { useGitBranches } from "@/features/git/queries";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { fsKeys } from "@/features/fs/keys";
import { CommentTray } from "@/features/cockpit/CommentTray";
import { getComments, clearComments } from "@/features/cockpit/commentStore";
import type { Message, MessageAction } from "@/lib/types";
import { IMAGE_MODEL_PRESETS, resolveImageProvider } from "@/lib/imageProviders";
import {
  VIDEO_MODEL_PRESETS,
  MUSIC_MODEL_PRESETS,
  VIDEO_RESOLUTIONS,
  VIDEO_DURATIONS,
  MINIMAX_DEFAULT_BASE_URL,
} from "@/lib/mediaGenProviders";
import { fallbackGradient, formatGenerationTime, imageDisplaySrc, ratioToCss, copyText as copyImageText } from "@/features/image/imageAssets";
import { pushToast } from "@/components/toast";
import { togglePinnedAsset, useStudioBrandBoard } from "@/features/studio/brandBoard";

type ImageResult = {
  id: number | string;
  prompt: string;
  ratio: string;
  model: string;
  seed: number;
  steps: number;
  guidance: number;
  style: string;
  hue: number;
  ts: string | number;
  status?: string;
  negative?: string | null;
  resultUrl?: string | null;
};

// Strip Windows extended-length prefix + trailing slashes, return last segment.
function basename(p: string | null | undefined): string {
  if (!p) return "votre espace de travail";
  const clean = p.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const seg = clean.split(/[\\/]/).filter(Boolean).pop();
  return seg || "votre espace de travail";
}

// ─── Chat (agent-style "cx" layout) ─────────────────────────
//
// Reads its message list from chat-sync (SQLite-backed). Cross-window sync
// with the mascot's FloatChat rides on chat://messages-changed.
export function ChatView({
  activeConv,
  model: modelProp,
  onOpenSnippet,
  disableSplit,
}: {
  activeConv: string;
  model?: string;
  onOpenSnippet?: (code: string, lang: string) => void;
  /** When true, suppress the in-chat split editor (used by the cockpit where
   *  the right panel IS the editor surface). Opening a file calls openFile()
   *  without ever setting splitFile. The /chat route (flag OFF) leaves this
   *  false so split behavior is unchanged there. */
  disableSplit?: boolean;
}) {
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [mode, setMode] = useState<"chat" | "image">("chat");
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const chatStream = useChatStream(activeConv);
  const { data: messages } = useMessages(activeConv);
  const [model, setModel] = useActiveModel(modelProp);
  // Trust-UX (Lane 5) — the active agent mode drives the permission badge under
  // the composer: read-only modes (Chat/Plan) get a "private" fact, the full
  // Agent mode gets a "guarded" (git safety net) fact instead of the old
  // ambiguous "local" chip.
  const [chatMode] = useChatMode();
  // Lot A — Task 12 : libellés des tool-calls du tour en cours (« 🔍 a lu … »,
  // « ✏️ a écrit … »), accumulés par le listener root et rendus dans le bloc de
  // streaming ci-dessous. Vidé à la fin du tour (done delta).
  const toolActivity = useChatToolActivity(activeConv);

  const navigate = useNavigate();
  const { activeFile, openFiles, openFile, fileContents, setFileContents, editorPrefs, compareFile, setCompareFile, applyCodeToFile, openRecentPicker } = useShell();

  // Phase 2 — Chat→Editor handoff. When a file is opened from an action card,
  // we reveal an in-chat split (chat left, CodeMirror right) instead of
  // leaving the chat view. `splitFile` null = no split.
  const [splitFile, setSplitFile] = useState<string | null>(null);

  // Lot A — contexte éditeur auto. Le composer du MAIN IDE a accès à l'éditeur
  // (activeFile + fileContents via useShell) ; il joint donc automatiquement le
  // fichier actif (+ la sélection courante) au message envoyé. La mascotte
  // (FloatChat) n'a pas de ShellContext réel → elle ne passe jamais editorCtx.
  //
  // `selection` est publiée par CodeMirrorEditor (editorSelectionStore). Le chip
  // ci-dessous montre ce qui sera envoyé et permet de le retirer pour un tour.
  // `ctxDropped` est remis à false après chaque envoi (le contexte se réactive
  // au tour suivant). Le toggle `chat.autoEditorContext` (défaut ON) le coupe.
  const selection = useEditorSelection();
  const [ctxDropped, setCtxDropped] = useState(false);
  const { data: autoCtxOn = true } = useQuery({
    queryKey: ["settings", "chat.autoEditorContext"],
    queryFn: async () => (await db.settings.get("chat.autoEditorContext")) !== "false",
    staleTime: 30_000,
  });

  // Real context chips: current git branch + workspace folder name.
  const { data: branches } = useGitBranches();
  const branch = branches?.current ?? null;
  const { data: wsRoot } = useQuery({
    queryKey: fsKeys.workspaceRoot(),
    queryFn: fsGetWorkspaceRoot,
    staleTime: Infinity,
    retry: false,
  });
  const cwd = basename(wsRoot);

  const isEmpty = !messages || messages.length === 0;

  // Phase 7 #4 — badge « 🔒 isolé » près du composer pendant un run isolé EN
  // COURS. On suit le transcript du DERNIER message agent (celui qui tourne, le
  // cas échéant) et on n'affiche le badge que tant que l'isolation est active
  // (worktreeStarted sans finalized). Le transcript est tenu à jour en live par
  // useAgentEvents ; subscribe avec null = no-op quand il n'y a aucun run agent.
  const latestAgentRunId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.viaAgent && typeof msg.agentId === "string") return msg.agentId;
    }
    return null;
  })();
  const { data: latestAgentTranscript } = useAgentTranscript(latestAgentRunId);
  const composerIsolated =
    latestAgentTranscript != null &&
    isWorktreeRunActive(extractWorktreeStatus(latestAgentTranscript.events));

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, typing, chatStream.streaming, chatStream.partial, chatStream.partialReasoning]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-grow du composer : la hauteur suit le contenu (borne CSS max-height,
  // scroll interne au-delà) — comme dans tous les harness de référence. Sans
  // ça, un prompt multi-lignes scrollait dans une bulle figée à 56px.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Ajout de sources — le « + » du composer ouvre un picker de fichiers du
  // workspace et insère une @-mention `@"chemin"` (résolue à l'envoi par le
  // flux mentions.ts existant : contenu joint au modèle, texte UI propre).
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const insertMention = useCallback((path: string) => {
    setInput((i) => (i && !/\s$/.test(i) ? i + " " : i) + `@"${path}" `);
    inputRef.current?.focus();
  }, []);
  // Demandes venues d'ailleurs (clic droit explorateur → « Ajouter au chat »).
  const mentionRequests = useChatMentionRequests();
  useEffect(() => {
    if (mentionRequests.length === 0) return;
    mentionRequests.forEach(insertMention);
    clearChatMentionRequests();
  }, [mentionRequests, insertMention]);

  // Agents disponibles via slash commands (`/code-reviewer ...`). Source =
  // `.md` sur disque (`~/.claude/agents/*.md` + workspace), refetch on focus.
  const { data: agentDefs } = useAgentDefs("all");
  const enabledAgents = useMemo(
    () => (agentDefs ?? []).filter((d) => d.enabled),
    [agentDefs],
  );

  // Palette de slash commands : ouverte dès que l'input commence par `/`. On
  // peut soit continuer à taper pour filtrer + Tab/↵ pour compléter, soit
  // taper directement `/<nom> texte` et le parser au send. Esc vide l'input.
  const [slashIndex, setSlashIndex] = useState(0);
  const slashFilter = useMemo(() => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return null;
    return trimmed.slice(1).split(/\s/)[0] ?? "";
  }, [input]);
  const slashMatches = useMemo(() => {
    if (slashFilter === null) return [];
    const f = slashFilter.toLowerCase();
    return enabledAgents.filter((d) => d.name.toLowerCase().startsWith(f));
  }, [enabledAgents, slashFilter]);
  const slashOpen = slashFilter !== null && slashMatches.length > 0;
  useEffect(() => {
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMatches.length, slashIndex]);

  /** Remplace le préfixe `/<filter>` par `/<name> ` et refocus le textarea. */
  const applySlash = useCallback(
    (name: string) => {
      const trimmed = input.trimStart();
      const rest = trimmed.startsWith("/")
        ? trimmed.slice(1).split(/\s/).slice(1).join(" ")
        : "";
      setInput(rest ? `/${name} ${rest}` : `/${name} `);
      setSlashIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [input],
  );

  const send = useCallback(async () => {
    const raw = input.trim();
    if (!raw && !pendingImage) return;
    // Parse une éventuelle slash command : `/<nom> reste du message`. Si le
    // nom matche un agent enabled, on consomme le `/<nom>` et on passe son
    // path à sendChatMessage (qui forcera la délégation côté chat-sync).
    let text = raw;
    let agentDefPath: string | undefined;
    if (raw.startsWith("/")) {
      const match = raw.match(/^\/(\S+)\s*([\s\S]*)$/);
      if (match) {
        const [, name, rest] = match;
        const hit = enabledAgents.find((d) => d.name === name);
        if (hit) {
          agentDefPath = hit.path;
          text = rest.trim();
        }
      }
    }
    if (!text && !pendingImage) return; // slash sans contenu : no-op

    // Lot A — contexte éditeur auto (main IDE uniquement). On joint le fichier
    // actif (+ sélection courante si elle le concerne) sauf si le toggle est
    // OFF ou que l'utilisateur a retiré le chip pour ce tour. La déduplication
    // avec les @-mentions est gérée côté sendChatMessage (chat-sync.ts).
    let editorCtx: Parameters<typeof sendChatMessage>[5] | undefined;
    if (autoCtxOn && !ctxDropped && activeFile && fileContents[activeFile]) {
      const sel =
        selection && selection.path === activeFile && selection.text.trim()
          ? { text: selection.text, startLine: selection.startLine, endLine: selection.endLine }
          : undefined;
      editorCtx = { path: activeFile, content: fileContents[activeFile].text, selection: sel };
    }

    // C2.4 — inline comments from the Révision diff. Read at send time (so any
    // note added after the last keystroke is captured). Passed as an optional
    // 7th param to sendChatMessage, which injects them EPHEMERALLY into the
    // API payload only (same pattern as editorCtx — never written to SQLite,
    // never shown in the user bubble). Passing undefined when empty → no-op,
    // identical code path to today. clearComments() only after success so the
    // queue is preserved if sendChatMessage throws (user can retry).
    const pendingComments = getComments();
    const commentsArg = pendingComments.length > 0 ? pendingComments : undefined;

    setInput("");
    const imageToSend = pendingImage;
    setPendingImage(null);
    setTyping(true);
    chatStream.start();
    try {
      await sendChatMessage(
        activeConv,
        text,
        model,
        imageToSend ?? undefined,
        agentDefPath,
        editorCtx,
        commentsArg,
      );
      // Clear ONLY after dispatch succeeds.
      if (commentsArg) clearComments();
    } finally {
      setTyping(false);
      chatStream.stop();
      setCtxDropped(false); // le contexte se réactive au tour suivant
    }
  }, [
    input,
    pendingImage,
    model,
    activeConv,
    chatStream,
    enabledAgents,
    autoCtxOn,
    ctxDropped,
    activeFile,
    fileContents,
    selection,
  ]);

  const onKey = (e: React.KeyboardEvent) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const hit = slashMatches[slashIndex];
        if (hit) {
          e.preventDefault();
          applySlash(hit.name);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Vide l'input pour fermer la palette (le `/` qui restait la rouvrirait).
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // Open a workspace file from an action card → reveal the in-chat split
  // (chat left, editor right), staying in the chat view. `openFile` loads the
  // content into the shared fileContents store first.
  // When `disableSplit` is true (cockpit), skip the split reveal so the file
  // only lands in the right-panel Éditeur surface (openFile alone is enough).
  const handleOpenFile = useCallback((path: string) => {
    setCompareFile(null); // opening a file for editing supersedes any open diff
    void (async () => {
      await openFile(path);
      if (!disableSplit) setSplitFile(path);
    })();
  }, [openFile, setCompareFile, disableSplit]);

  const closeSplit = useCallback(() => setSplitFile(null), []);
  const openFullEditor = useCallback(() => {
    setSplitFile(null);
    void navigate({ to: "/code" });
  }, [navigate]);

  // Split editor edits write through to the SAME fileContents store /code
  // uses, marking the file dirty. Saving happens via "Plein écran" → /code
  // (Ctrl+S); the split is a handoff/preview surface, not a second save path.
  const onSplitChange = useCallback((v: string) => {
    if (!splitFile) return;
    setFileContents((c: any) => ({ ...c, [splitFile]: { ...c[splitFile], text: v, dirty: true } }));
  }, [splitFile, setFileContents]);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    try {
      setPendingImage(await readFileAsDataUrl(file));
    } catch (err) {
      console.warn("[ChatView] paste image read failed:", err);
    }
  }, []);

  const composer = (
    <>
      {/* C2.4 — pending inline comments tray. Returns null when empty (no-comments
          path unchanged). Visible only when the user has queued notes from the
          Révision diff, independently of the cockpit flag. */}
      <CommentTray />
      <div className="cx-composer" style={{ position: "relative" }}>
        {slashOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              right: 0,
              maxHeight: 260,
              overflowY: "auto",
              background: "rgba(20,16,38,0.96)",
              backdropFilter: "blur(20px) saturate(180%)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              boxShadow: "0 18px 44px -18px rgba(0,0,0,0.7)",
              padding: 6,
              zIndex: 50,
            }}
          >
            <div
              style={{
                padding: "4px 10px 6px",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Agents · ↑↓ naviguer · Tab/↵ insérer · Esc annuler
            </div>
            {slashMatches.map((d, i) => (
              <button
                key={d.path}
                type="button"
                onClick={() => applySlash(d.name)}
                onMouseEnter={() => setSlashIndex(i)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  borderRadius: 6,
                  background:
                    i === slashIndex
                      ? "rgba(224,142,254,0.14)"
                      : "transparent",
                  border: 0,
                  color: "var(--on-surface)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  /{d.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--on-surface-muted)",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.description || "—"}
                </span>
              </button>
            ))}
          </div>
        )}
        {pendingImage && (
          <div className="cx-pending">
            <img src={pendingImage} alt="pending attachment" />
            <button onClick={() => setPendingImage(null)} title="Retirer l'image">×</button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try { setPendingImage(await readFileAsDataUrl(file)); }
            catch (err) { console.warn("[ChatView] file attach read failed:", err); }
            e.target.value = "";
          }}
        />
        <textarea
          ref={inputRef}
          className="cx-composer-input"
          placeholder={
            mode === "image"
              ? "Décris l'image que tu veux générer…"
              : isEmpty ? "Pose une question ou décris une tâche…" : "Demander des modifications de suivi…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={handlePaste}
          rows={1}
        />
        <div className="cx-composer-bar">
          {/* « + » = ajouter des sources (pattern Cursor/Claude Desktop) :
              ouvre un picker de fichiers du workspace, insère une @-mention. */}
          <button
            className="cx-tool"
            title="Ajouter un fichier comme source (@fichier) — son contenu sera joint au message"
            aria-label="Ajouter un fichier comme source"
            onClick={() => setMentionPickerOpen(true)}
          >
            <Icon name="plus" size={15} />
          </button>
          {/* Le mode (Chat / Plan / Agent) est LE contrat du message qu'on
              s'apprête à envoyer : il vit DANS le composer (pattern Cursor /
              Codex), pas dans la rangée de contexte flottante en dessous. */}
          <ModeSelector />
          <button className="cx-tool" title="Joindre une image" onClick={() => fileInputRef.current?.click()}>
            <Icon name="attach" size={15} />
          </button>
          {/* 📷 capture d'écran → même flux pendingImage que le paste/attach. */}
          <CaptureButton className="cx-tool" iconSize={15} onCaptured={setPendingImage} />
          <button
            className={"cx-tool" + (mode === "image" ? " on" : "")}
            onClick={() => setMode((m) => (m === "image" ? "chat" : "image"))}
            title="Mode image"
          >
            <Icon name="image" size={15} />
          </button>
          {/* Le bouton micro « Voix » (inerte, aucun flux derrière) est retiré —
              un contrôle mort abîme la confiance plus qu'un contrôle absent. */}
          <div className="cx-spacer" />
          <ModelPicker model={model} onChange={setModel} className="composer-model" />
          {typing ? (
            <button
              className="cx-send stop"
              title="Arrêter la génération"
              onClick={() => { chatStream.abort(); setTyping(false); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            </button>
          ) : (
            <button className="cx-send" onClick={() => void send()} disabled={!input.trim() && !pendingImage} title="Envoyer (↵)">
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
        {/* Rangée de contexte INTÉGRÉE à la bulle (retour utilisateur : des
            chips flottants sous le composer « font étranges ») — un pied de
            carte discret, séparé par un fin trait, comme Cursor/Claude. */}
        <div className="cx-ctx-row">
        {/* Lot A — chip contexte éditeur retirable. Montre le fichier actif (+
            sélection) qui sera joint au prochain message. Le × le retire pour
            ce tour (réactivé après envoi). Réutilise .cx-chip (charte glass). */}
        {autoCtxOn && !ctxDropped && activeFile && (
          <span className="cx-chip ctx-editor" title="Contexte envoyé au modèle — cliquez × pour ne pas l'envoyer">
            <span aria-hidden>📄</span>
            <span className="name">{basename(activeFile)}</span>
            {selection?.path === activeFile && selection.text.trim() && (
              <span className="sel" title="Sélection courante incluse">
                ⊿ sélection ({selection.endLine - selection.startLine + 1} l.)
              </span>
            )}
            <button
              type="button"
              className="ctx-x"
              title="Ne pas envoyer ce contexte"
              onClick={() => setCtxDropped(true)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                opacity: 0.6,
                padding: 0,
                marginLeft: 2,
                lineHeight: 1,
                font: "inherit",
              }}
            >
              ×
            </button>
          </span>
        )}
        {/* Le ModeSelector a migré DANS la barre du composer (ci-dessus) — cette
            rangée ne porte plus que du CONTEXTE (fichier joint, workspace,
            branche, isolation, permission). Chaque chip cliquable mène à la
            surface qui le gère (fini les pseudo-boutons inertes). */}
        <button
          className="cx-chip"
          title={`Projet ouvert : ${cwd ?? "aucun"} — cliquer pour changer de projet (récents)`}
          onClick={openRecentPicker}
        >
          <Icon name="folder" size={11} />
          {cwd}
        </button>
        {branch && (
          <button
            className="cx-chip branch"
            title={`Branche git : ${branch} — cliquer pour ouvrir Source Control (diff, commit, historique)`}
            onClick={() => navigate({ to: "/git" })}
          >
            <span className="dot" />
            {branch}
          </button>
        )}
        {/* Phase 7 #4 — badge « 🔒 isolé » pendant un run isolé en cours : le
            travail de l'agent vit dans un worktree git séparé, ton checkout
            principal reste intact jusqu'au merge (manuel) depuis le panneau
            Agents. Non interactif — pur indicateur d'état. */}
        {composerIsolated && (
          <span
            className="cx-chip"
            title="Run en cours isolé dans un worktree git — ton checkout principal reste intact jusqu'au merge (depuis le panneau Agents)."
            style={{
              color: "var(--primary, #7c3aed)",
              borderColor: "rgba(124, 58, 237, 0.45)",
            }}
          >
            🔒 isolé
          </span>
        )}
        <div className="cx-chip-spacer" />
        {/* Trust-UX (Lane 5) — remplace l'ancien chip « 🛡 local » ambigu (local =
            privé ? sandboxé ? peut-toucher-mes-fichiers ?) par un fait de
            permission PRÉCIS, dépendant du mode :
              • Chat / Plan (lecture seule) → « Privé · sur ta machine » (rien
                n'est écrit ni exécuté) ;
              • Agent (exec directe)        → « Filet git » (les actions sont
                réversibles dans l'onglet Git). */}
        {chatMode === "agent" ? (
          <PermissionBadge
            kind="guarded"
            label="Filet git"
            title="Mode Agent — l'agent peut écrire et exécuter sur ton projet. Chaque modification reste réversible dans Source Control (le filet de sécurité). Cliquer pour voir le diff."
            onClick={() => navigate({ to: "/git" })}
          />
        ) : (
          <PermissionBadge
            kind="private"
            label="Privé · sur ta machine"
            title="Mode lecture seule — l'inférence et tes données restent locales ; aucun fichier n'est modifié ni aucune commande exécutée ce tour-ci."
          />
        )}
        </div>
      </div>
    </>
  );

  const chatMain = (
    <div className="cx">
      {!isEmpty && (
        <div className="cx-head">
          <span className="dot" />
          <span className="title">{cwd}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{messages.length} message{messages.length > 1 ? "s" : ""}</span>
        </div>
      )}

      {isEmpty ? (
        <div className="cx-empty">
          <div className="cx-empty-spark"><Icon name="sparkle" size={26} /></div>
          <h1 className="cx-empty-title">
            Que devrions-nous construire dans <span className="acc">{cwd}</span> ?
          </h1>
          <div className="cx-empty-composer">{composer}</div>
        </div>
      ) : (
        <>
          <div className="cx-feed scroll" ref={feedRef}>
            <div className="cx-feed-inner">
              {messages.map((m) => (
                <CxMessage
                  key={String(m.id)}
                  m={m}
                  model={model}
                  onOpenFile={handleOpenFile}
                  onOpenSnippet={onOpenSnippet}
                  activeFile={activeFile}
                  onApply={(code, lang, target) => void applyCodeToFile(code, lang, target)}
                />
              ))}
              {/* Bulle « en train de travailler » : visible quand CETTE fenêtre
                  envoie (typing local) OU quand un stream est en cours POUR la
                  conversation active, quelle que soit la fenêtre émettrice
                  (chatStream filtre déjà par convId). Indispensable pour que le
                  chat principal reflète EN DIRECT un prompt lancé depuis la
                  mascotte — les deux fenêtres reçoivent le même broadcast
                  chat://delta, mais sans cette 2e condition seul l'émetteur
                  l'affichait. */}
              {(typing || chatStream.streaming) && (
                <div className="cx-msg ai">
                  <div className="cx-meta">
                    <span className="mark ai"><Icon name="sparkle" size={11} /></span>
                    <span className="who">Shugu</span>
                    <span className="sep">·</span>
                    <span className="ts">en train de travailler…</span>
                  </div>
                  {/* Lot A — Task 12 : activité des outils du tour en cours. Une
                      ligne discrète par tool-call (« 🔍 a lu … », « ✏️ a écrit … »),
                      au-dessus du contenu/reasoning. Vidée à la fin du tour. */}
                  {toolActivity.length > 0 && (
                    <div className="cx-tool-activity">
                      {toolActivity.map((label, i) => (
                        <div key={i} className="cx-tool-line">
                          {label}
                        </div>
                      ))}
                    </div>
                  )}
                  {chatStream.streaming && (chatStream.partial || chatStream.partialReasoning) ? (
                    <div className="cx-body">
                      {chatStream.partialReasoning && (
                        <ThinkBlock open text={chatStream.partialReasoning} />
                      )}
                      {chatStream.partial && <Markdown text={chatStream.partial} />}
                    </div>
                  ) : toolActivity.length > 0 ? (
                    <div className="cx-working">
                      <span className="ring" />
                      utilisation des outils · {model}
                    </div>
                  ) : (
                    <div className="cx-working">
                      <span className="ring" />
                      analyse du contexte · {model}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="cx-composer-wrap">{composer}</div>
        </>
      )}
      {/* Contextual cards — the trigger is portaled into the titlebar (sits with
          History/Bell/Settings); the panel floats here when opened. Mounted for
          the whole chat view incl. the empty state; chatMain isn't rendered
          during the handoff split, so that case is already excluded. */}
      <ContextBubble convId={activeConv} />
      {/* Picker « + » du composer — réutilise QuickOpen (fuzzy sur le
          workspace) mais insère une @-mention au lieu d'ouvrir l'éditeur. */}
      <QuickOpenPalette
        open={mentionPickerOpen}
        onClose={() => setMentionPickerOpen(false)}
        onOpen={insertMention}
      />
    </div>
  );

  if (!splitFile && !compareFile) return chatMain;
  // In the cockpit (disableSplit), never render the in-chat split — the right
  // panel is the editor surface. Return chatMain only.
  if (disableSplit) return chatMain;

  // Phase 2 — handoff split: chat on the left, the opened file on the right.
  // The right pane shows a read-only git diff (working tree vs HEAD) when a
  // change is selected in the Git context card (compareFile), otherwise the
  // CodeMirror editor for the opened file (splitFile). Separate editor instance
  // from /code; light edits flow through the shared fileContents store and
  // "Plein écran" promotes to /code for saving.
  const splitContent = splitFile ? fileContents[splitFile] : undefined;
  return (
    <div className="chat-split">
      <div className="chat-split-left">{chatMain}</div>
      <div className="chat-split-right">
        {compareFile ? (
          <GitDiffView path={compareFile.right} onClose={() => setCompareFile(null)} />
        ) : splitFile ? (
          <>
            <div className="chat-split-head">
              <span className="dot ide" />
              <span className="label">Éditeur</span>
              <span className="sep">·</span>
              <span className="path">{splitFile}</span>
              <span style={{ flex: 1 }} />
              <button className="lgb lgb-sm" onClick={openFullEditor} aria-label="Ouvrir en plein écran" title="Ouvrir en plein écran">
                <Icon name="code" size={13} />
              </button>
              <button className="split-close" onClick={closeSplit} title="Fermer le split">
                <Icon name="x" size={12} />
              </button>
            </div>
            <div className="chat-split-editor">
              <CodeMirrorEditor
                value={splitContent?.text ?? ""}
                onChange={onSplitChange}
                path={splitFile}
                wordWrap={editorPrefs.wordWrap}
                stickyScroll={editorPrefs.stickyScroll}
                minimap={editorPrefs.minimap}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Review feedback widget (👍/👎) — exported for ChatPanel ─
//
// Rendered only on messages that are review outputs (body starts with
// "🔎 Revue", viaAgent=true, agentId set). Clicking a button writes
// validated=1 or validated=0 to agent_reviews via the reviewerId.
// Local state tracks which button is selected for this render cycle;
// no re-fetch needed — the DB write is the source of truth.
export function ReviewFeedback({ reviewerId }: { reviewerId: string }) {
  // null = état inconnu ; 1 = retenue (👍 / auto-validée) ; 0 = exclue (👎 / auto-exclue)
  const [vote, setVote] = useState<1 | 0 | null>(null);
  const [saving, setSaving] = useState(false);

  // Reflète l'état VALIDÉ actuel de la review (auto par R3, ou un vote précédent),
  // pour que l'utilisateur voie si elle est déjà retenue/exclue avant de voter.
  useEffect(() => {
    let cancelled = false;
    void db.reviews
      .getValidatedByReviewer(reviewerId)
      .then((v) => { if (!cancelled && v !== null) setVote(v === 1 ? 1 : 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reviewerId]);

  const handleVote = async (value: 1 | 0) => {
    if (saving) return;
    setSaving(true);
    try {
      await db.reviews.setValidatedByReviewer(reviewerId, value);
      setVote(value);
    } catch (err) {
      console.warn("[ReviewFeedback] setValidatedByReviewer failed:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginTop: 6,
        fontSize: 11,
        color: "var(--on-surface-muted)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span>Cette revue était utile ?</span>
      <button
        type="button"
        title="Utile — sera réinjectée comme leçon"
        disabled={saving}
        onClick={() => void handleVote(1)}
        style={{
          background: vote === 1 ? "rgba(34,197,94,0.18)" : "transparent",
          border: vote === 1 ? "1px solid rgba(34,197,94,0.45)" : "1px solid rgba(255,255,255,0.1)",
          borderRadius: 5,
          cursor: saving ? "default" : "pointer",
          padding: "2px 7px",
          fontSize: 13,
          lineHeight: 1,
          opacity: saving ? 0.5 : 1,
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        👍
      </button>
      <button
        type="button"
        title="Pas utile — sera exclue de l'apprentissage"
        disabled={saving}
        onClick={() => void handleVote(0)}
        style={{
          background: vote === 0 ? "rgba(239,68,68,0.18)" : "transparent",
          border: vote === 0 ? "1px solid rgba(239,68,68,0.45)" : "1px solid rgba(255,255,255,0.1)",
          borderRadius: 5,
          cursor: saving ? "default" : "pointer",
          padding: "2px 7px",
          fontSize: 13,
          lineHeight: 1,
          opacity: saving ? 0.5 : 1,
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        👎
      </button>
      {vote !== null && (
        <span style={{ fontSize: 10, opacity: 0.7 }}>
          {vote === 1 ? "✓ retenue (leçon)" : "✗ exclue de l'apprentissage"}
        </span>
      )}
    </div>
  );
}

// ─── Live agent activity timeline ───────────────────────────────
// Rendu dans la bulle de l'orchestrateur : montre EN DIRECT ce que l'agent fait
// (lit / écrit / exécute), avec un chrono et un état travaille/terminé/échec.
// Les données viennent du transcript (useMessageDisplay → useAgentTranscript),
// déjà tenu à jour en live par useAgentEvents (agent://lifecycle). Repliable :
// déplié pendant le run, repliable une fois terminé — l'historique des actions
// reste consultable. C'est le correctif au « placeholder figé » : avant, le fil
// ne montrait QUE « Orchestrateur au travail… » jusqu'au résultat final ; les
// commandes/outils (le vrai travail) vivaient uniquement dans le drawer Agents.
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// `AgentPlan` (checklist `todo_write`) est désormais un composant partagé
// (./AgentPlan) — réutilisé tel quel par l'onglet "Plan" du panneau Contexte.

// Une ligne de la timeline. Quand l'outil a renvoyé une sortie (`result`), la
// ligne devient dépliable (clic → <pre> de la sortie : stdout/exit d'une
// commande, contenu lu, message d'erreur). Sinon c'est une ligne simple.
function ActivityRow({ it }: { it: AgentActivityItem }) {
  const head = (
    <>
      <span className="ic">{it.icon}</span>
      <span className="lb">{it.label}</span>
      {it.detail && <span className="dt" title={it.detail}>{it.detail}</span>}
      <span className="st">
        {it.status === "running" ? "…" : it.status === "error" ? "✗" : "✓"}
      </span>
    </>
  );
  // La carte de risque (chip danger + « toujours autoriser/refuser ») est
  // TOUJOURS visible quand la commande est flaggée — hors du <details> pour ne
  // pas la cacher quand la sortie est repliée.
  const riskCard = it.risk ? (
    <CommandRiskCard risk={it.risk} command={it.command} />
  ) : null;

  if (!it.result && !it.imageUrl) {
    return (
      <li className={"act " + it.status}>
        {head}
        {riskCard}
      </li>
    );
  }
  return (
    <li className={"act has-out " + it.status}>
      <details>
        <summary>{head}</summary>
        {it.tool === "browser_test" ? (
          // Viewer dédié : verdict réussite/échec + capture + assertions.
          <BrowserTestResultViewer summary={it.result} imageUrl={it.imageUrl} />
        ) : (
          <>
            {/* Preuve visuelle d'un capture_screen — miniature dépliable. */}
            {it.imageUrl && (
              <img
                src={it.imageUrl}
                alt="Capture d'écran prise par l'agent"
                style={{ maxWidth: "100%", borderRadius: 6, marginTop: 6, display: "block" }}
              />
            )}
            {it.result && <pre className="out">{it.result}</pre>}
          </>
        )}
      </details>
      {riskCard}
    </li>
  );
}

function AgentActivity({
  items,
  status,
  startedAt,
  finishedAt,
  agentId,
}: {
  items: AgentActivityItem[];
  status?: AgentStatus;
  startedAt?: number;
  finishedAt?: number | null;
  /** Pour le bouton Stop (kill l'agent en cours). */
  agentId?: string;
}) {
  const running = status === "running" || status === "pending";

  // Ticker 1 s pendant le run : une commande longue peut ne rien émettre
  // pendant 30 s — sans ça le chrono semblerait figé et l'utilisateur croirait
  // l'agent planté. S'arrête net dès la fin du run.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const [killed, setKilled] = useState(false);

  if (!running && items.length === 0) return null;

  const elapsed = startedAt != null ? fmtElapsed((finishedAt ?? Date.now()) - startedAt) : "";
  // `killed` (clic Stop local) : on dit « Arrêté », pas « Échec » — l'agent n'a
  // pas planté, l'utilisateur l'a stoppé (le statut backend devient error/killed).
  const headLabel = running
    ? (killed ? "Arrêt…" : "Travaille…")
    : killed ? "Arrêté"
    : status === "error" ? "Échec"
    : "Terminé";

  return (
    <details className={"cx-agent-activity" + (running ? " running" : "")} open={running}>
      <summary>
        <span className={"dot" + (running ? " live" : "")} />
        <span className="hl">{headLabel}</span>
        {elapsed && <span className="el">{elapsed}</span>}
        {items.length > 0 && (
          <span className="ct">{items.length} action{items.length > 1 ? "s" : ""}</span>
        )}
        {running && agentId && (
          <button
            type="button"
            className="stop"
            title="Arrêter l'agent"
            disabled={killed}
            // stopPropagation : ne pas replier le <details> en cliquant Stop.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setKilled(true);
              void killAgent(agentId).catch(() => setKilled(false));
            }}
          >
            {killed ? "Arrêt…" : "✕ Stop"}
          </button>
        )}
      </summary>
      {items.length > 0 && (
        <ul>
          {items.map((it) => (
            <ActivityRow key={it.key} it={it} />
          ))}
        </ul>
      )}
      {!running && elapsed && (
        <div className="foot">
          {killed ? "⏹ Arrêté" : status === "error" ? "✗ Échec" : "✓ Terminé"} · {elapsed}
        </div>
      )}
    </details>
  );
}

// ─── Bandeau d'isolation worktree (Phase 7 #4) ──────────────────
// L'agent en mode Agent travaille par DÉFAUT dans un worktree git isolé ; le
// merge n'est plus automatique. Ce bandeau COMPACT, rendu dans la bulle du run
// agent, signale l'état d'isolation et renvoie vers le panneau Agents (via
// app://reveal-agent) où l'utilisateur relit le diff puis merge ou jette. Il ne
// duplique PAS les boutons Merger/Jeter (ils vivent dans le panneau Agents, la
// surface de revue) — il reste un indicateur non bloquant.
function WorktreeBanner({
  worktree,
  agentId,
}: {
  worktree: WorktreeStatus;
  agentId: string;
}) {
  const { started, finalized, skipped } = worktree;

  // Aucun signal d'isolation → rien (run in-place classique).
  if (!started && !finalized && !skipped) return null;

  // Style commun : une fine bande sous la timeline, tokens CSS, non intrusive.
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    padding: "5px 9px",
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.4,
  };

  // Pas d'espace isolé pour ce run → info d'état (l'agent travaille quand
  // même, directement sur les fichiers) : habillage neutre, pas une alerte.
  if (skipped) {
    return (
      <div
        style={{
          ...base,
          background: "rgba(96, 165, 250, 0.08)",
          border: "1px solid rgba(96, 165, 250, 0.28)",
          color: "var(--info, #60a5fa)",
        }}
      >
        <span>ℹ L'agent travaille directement dans tes fichiers — pas de copie isolée pour ce run ({skipped.reason})</span>
      </div>
    );
  }

  // Diff prêt à relire → bandeau cliquable qui ouvre le panneau Agents.
  if (finalized && finalized.outcome === "diff") {
    return (
      <button
        type="button"
        onClick={() => void revealAgent(agentId)}
        title="Relire le diff et merger / jeter dans le panneau Agents"
        style={{
          ...base,
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "inherit",
          background: "rgba(124, 58, 237, 0.08)",
          border: "1px solid rgba(124, 58, 237, 0.30)",
          color: "var(--on-surface, #ddd)",
        }}
      >
        <span aria-hidden>🔒</span>
        <span style={{ flex: 1 }}>
          Run isolé — diff prêt à relire
          {finalized.branch && (
            <span
              style={{
                marginLeft: 6,
                fontFamily: "var(--font-mono)",
                color: "var(--on-surface-variant, #a5a0bf)",
              }}
            >
              {finalized.branch}
            </span>
          )}
        </span>
        <span style={{ color: "var(--primary, #7c3aed)", fontWeight: 600 }}>
          Relire ›
        </span>
      </button>
    );
  }

  // Finalisé sans diff (mergé / no-changes / jeté) → statut texte discret.
  if (finalized) {
    const text =
      finalized.outcome === "merged"
        ? "✅ Run isolé mergé"
        : finalized.outcome === "no-changes"
          ? "Run isolé — rien à merger"
          : finalized.outcome === "discarded"
            ? "Run isolé jeté"
            : `Run isolé — ${finalized.outcome}`;
    return (
      <div
        style={{
          ...base,
          background: "rgba(124, 58, 237, 0.05)",
          border: "1px solid rgba(124, 58, 237, 0.18)",
          color: "var(--on-surface-variant, #a5a0bf)",
        }}
      >
        <span>{text}</span>
      </div>
    );
  }

  // Démarré, pas encore finalisé → run isolé EN COURS.
  if (isWorktreeRunActive(worktree)) {
    return (
      <div
        style={{
          ...base,
          background: "rgba(124, 58, 237, 0.06)",
          border: "1px solid rgba(124, 58, 237, 0.22)",
          color: "var(--on-surface, #ddd)",
        }}
      >
        <span aria-hidden>🔒</span>
        <span>
          Run isolé dans{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--primary, #7c3aed)" }}>
            {started?.branch}
          </span>
        </span>
      </div>
    );
  }

  return null;
}

// ─── Per-message renderer ───────────────────────────────────
function CxMessage({
  m,
  model,
  onOpenFile,
  onOpenSnippet,
  activeFile,
  onApply,
}: {
  m: Message;
  model: string;
  onOpenFile: (path: string) => void;
  onOpenSnippet?: (code: string, lang: string) => void;
  /** Lot A (Task 8) — active editor file: the Apply fallback target. */
  activeFile?: string | null;
  /** Lot A (Task 8) — apply a code block to a file (diff accept/reject). */
  onApply?: (code: string, lang: string, target: string) => void;
}) {
  const {
    displayBody,
    liveReasoning,
    isStreamingAgent,
    imageDataUrl,
    isAgentRun,
    agentRole,
    agentStatus,
    activity,
    plan,
    writeRecords,
    startedAt,
    finishedAt,
    worktree,
  } = useMessageDisplay(m);

  // Le journal d'activité ne s'affiche que pour le travail de l'ORCHESTRATEUR,
  // pas pour les messages de plan / revue (préfixés 📋 / 🔎) que l'advisor
  // appose — ceux-là sont déjà du texte lisible tel quel.
  const showActivity =
    isAgentRun &&
    agentRole === "orchestrator" &&
    !/^(📋|🔎)/.test(m.body ?? "");

  // Trust-UX (Lane 5) — mode Ask/Plan/Act affiché dans la bulle agent. La mode
  // exact n'est PAS persistée sur le message ; on la DÉRIVE honnêtement des
  // PREUVES du transcript : un run qui a écrit un fichier ou lancé une commande
  // a forcément tourné en mode Act (agent) ; un run qui n'a fait que lire/chercher
  // (le runner retire les outils mutants en mode Plan) est étiqueté Plan. C'est du
  // comportement OBSERVÉ, pas une supposition. Tant que le run n'a encore rien fait
  // d'observable, on n'affiche pas de badge plutôt que d'en inventer un.
  const didExec = activity.some((a) => a.icon === "⚙️");
  const didWrite = writeRecords.length > 0 || activity.some((a) => a.icon === "✍️");
  const derivedMode: "agent" | "plan" | null =
    !isAgentRun ? null : didExec || didWrite ? "agent" : activity.length > 0 ? "plan" : null;

  if (m.role === "user") {
    return (
      <div className="cx-msg user">
        <div className="cx-meta">
          <span className="mark user">›</span>
          <span className="who">Toi</span>
          <span className="sep">·</span>
          <span className="ts">{m.ts}</span>
        </div>
        <div className="cx-body">
          {imageDataUrl ? <img src={imageDataUrl} alt="pièce jointe" /> : renderInlineCode(m.text ?? "")}
        </div>
      </div>
    );
  }

  return (
    <div className="cx-msg ai">
      <div className="cx-meta">
        <span className="mark ai"><Icon name="sparkle" size={11} /></span>
        <span className="who">Shugu</span>
        <span className="sep">·</span>
        <span className="ts">{m.ts}</span>
        <span className="sep">·</span>
        <span className="pill">{model}</span>
        {/* Trust-UX (Lane 5) — badge de mode Ask/Plan/Act dérivé des preuves du
            transcript (voir derivedMode plus haut). Affiché uniquement quand le
            run a fait quelque chose d'observable. */}
        {derivedMode && <ModeBadge mode={derivedMode} />}
        {m.viaAgent && m.agentId && (
          <button
            type="button"
            className="via-agent"
            onClick={() => void revealAgent(m.agentId!)}
            title="Voir la trace de l'orchestrateur"
            // Neutralise les défauts <button> (appearance / margin) sans toucher à
            // la typo : .cx-meta .via-agent impose déjà font/background/border, donc
            // le bouton reste visuellement identique au chip — mais avec la VRAIE
            // sémantique d'action cliquable (plus de span onClick).
            style={{ appearance: "none", margin: 0 }}
          >
            via orchestrator
          </button>
        )}
      </div>

      {isStreamingAgent && liveReasoning && !m.reasoning && <ThinkBlock open text={liveReasoning} />}
      {m.reasoning && <ThinkBlock text={m.reasoning} label={`Thinking (${m.reasoning.length} chars)`} />}

      {showActivity && plan && plan.length > 0 && <AgentPlan steps={plan} />}
      {showActivity && (
        <AgentActivity
          items={activity}
          status={agentStatus}
          startedAt={startedAt}
          finishedAt={finishedAt}
          agentId={m.agentId}
        />
      )}

      {/* Phase 7 #4 — bandeau d'isolation worktree. Non bloquant : il signale
          juste qu'un run a tourné isolé et pointe vers le panneau Agents où on
          relit le diff et on merge/jette. */}
      {isAgentRun && m.agentId && (
        <WorktreeBanner worktree={worktree} agentId={m.agentId} />
      )}

      <div className="cx-body">
        {imageDataUrl ? (
          <img src={imageDataUrl} alt="image générée" />
        ) : (
          <>
            {displayBody && <Markdown text={displayBody} />}
            {m.code && (
              <CodeBlock
                lang={m.code.lang}
                text={m.code.text}
                onOpen={onOpenSnippet ? () => onOpenSnippet(m.code!.text, m.code!.lang) : undefined}
                activeFile={activeFile}
                onApply={onApply}
              />
            )}
            {m.action && <ActionCard action={m.action} onOpenFile={onOpenFile} />}
          </>
        )}
        {/* Lot C3 — Carte d'opération in-chat : "✏️ N fichier(s) modifié(s)"
            avec liste dépliable des fichiers + diff par fichier + bouton Annuler ↺.
            Retourne null quand il n'y a pas d'écritures pour ce message. */}
        {/* Mode AGENT : les écritures viennent du transcript (events `write`),
            pas du store chat-direct. Sinon (chat direct) → fallback store. */}
        <ChatWritesCard
          messageId={String(m.id)}
          onOpenFile={onOpenFile}
          records={showActivity && writeRecords.length > 0 ? writeRecords : undefined}
        />
        <div className="cx-react">
          <button title="Copier" onClick={() => copyText(displayBody || m.body || m.text || "")}>
            <Icon name="copy" size={12} />
          </button>
        </div>
        {m.viaAgent && m.agentId && m.body?.startsWith("🔎 Revue (") && (
          <ReviewFeedback reviewerId={m.agentId} />
        )}
      </div>
    </div>
  );
}


function copyText(text: string) {
  if (text && typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}

// Collapsible reasoning / thinking trace.
function ThinkBlock({ text, open = false, label = "Thinking…" }: { text: string; open?: boolean; label?: string }) {
  return (
    <details className="cx-think" open={open}>
      <summary>{label}</summary>
      <div className="body">{text}</div>
    </details>
  );
}

// Inline-code-only renderer — used for USER messages (no full markdown needed
// there). AI bodies go through <Markdown> (markdownView.tsx). No innerHTML.
function renderInlineCode(text: string): React.ReactNode[] {
  // Split on `inline code` spans, keeping the delimited groups.
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={i} className="cx-code-inline">{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// "N files modified" card from a message's structured `action` field.
function ActionCard({ action, onOpenFile }: { action: MessageAction; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="cx-action">
      <div className="cx-action-head">
        <div className="cx-action-ico"><Icon name="diff" size={15} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cx-action-title">{action.title}</div>
          <div className="cx-action-sub">
            <span className="plus">+{action.add}</span>
            <span className="minus">−{action.rem}</span>
            <span style={{ opacity: 0.6 }}>· {action.files.length} fichier{action.files.length > 1 ? "s" : ""}</span>
          </div>
        </div>
        <div className="cx-action-actions">
          <button className="cx-action-btn" onClick={() => setOpen((o) => !o)}>{open ? "Masquer" : "Détails"}</button>
        </div>
      </div>
      {open && (
        <div className="cx-action-files">
          {action.files.map((f) => (
            <button type="button" key={f.name} className="cx-action-file" onClick={() => onOpenFile(f.name)} title="Ouvrir dans l'éditeur" aria-label={`Ouvrir ${f.name} dans l'éditeur`}>
              <span className={"dot " + f.st} />
              <span className="name">{f.name}</span>
              <span className="stats">
                <span className="add">+{f.add}</span>
                <span className="rem">−{f.rem}</span>
              </span>
              <span className="open-hint">Ouvrir ›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Code block inside an AI message body (Codex-styled).
export function CodeBlock({
  lang,
  text,
  onOpen,
  activeFile,
  onApply,
}: {
  lang: string;
  text: string;
  onOpen?: () => void;
  /** Lot A (Task 8) — active editor file: the Apply fallback target when the
   *  block declares no path of its own. */
  activeFile?: string | null;
  /** Lot A (Task 8) — apply this block to a file with inline diff (no LLM). */
  onApply?: (code: string, lang: string, target: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  // Lot A (Task 8) — résolution de la cible d'apply. On regarde d'abord un
  // chemin déclaré DANS le bloc (commentaire de 1ʳᵉ ligne `// src/x.ts` — le
  // seul indice qui survit à la persistance SQLite, l'info-string `lang path`
  // ayant déjà été consommée en `lang` au parse). À défaut, on retombe sur le
  // fichier actif de l'éditeur. null ⇒ rien à cibler → bouton désactivé.
  const applyTarget = detectBlockPath(text) ?? activeFile ?? null;
  const canApply = !!onApply && !!applyTarget;
  // HTML blocks get a live "Aperçu" — the payoff of activating a design
  // system (Design view → "Utiliser dans le chat") is SEEING the generated
  // UI. Rendered via srcdoc in a sandboxed iframe (no network, no
  // same-origin) inside a portal overlay so it escapes the chat feed's
  // overflow clipping. NOT the chat-split-right editor pane — that's for
  // files on disk; this is an ephemeral render of inline output.
  const isHtml = lang === "html" || lang === "htm";

  return (
    <div className="cx-code-block">
      <div className="cx-code-block-head">
        <span className="lang"><span className="dot" /> {lang}</span>
        <span style={{ display: "flex", gap: 6 }}>
          {isHtml && (
            <button className="cx-tool" title="Aperçu HTML" onClick={() => setPreview(true)} style={{ color: "var(--tertiary)" }}>
              <Icon name="image" size={12} />
            </button>
          )}
          <button className="cx-tool" title="Copier" onClick={() => copyText(text)}><Icon name="copy" size={12} /></button>
          {/* Lot A (Task 8) — bouton « Appliquer » : pose une ApplyRequest sur la
              cible résolue → diff inline accept/reject, ZÉRO appel LLM. Le title
              est porté par le <span> englobant : un <button disabled> n'émet pas
              de tooltip natif dans WebView2, donc sans ce wrap le message d'aide
              (« ouvre un fichier… ») resterait invisible justement quand on en a
              besoin. */}
          <span
            style={{ display: "inline-flex" }}
            title={
              canApply
                ? `Appliquer à ${applyTarget} (diff à accepter / refuser)`
                : "Ouvre un fichier ou précise un chemin (```ts src/foo.ts)"
            }
          >
            <button
              className="cx-tool"
              onClick={canApply ? () => onApply!(text, lang, applyTarget!) : undefined}
              disabled={!canApply}
              style={canApply ? { color: "var(--secondary)" } : undefined}
            >
              <Icon name="check" size={12} />
            </button>
          </span>
          <button
            className="cx-tool"
            title="Ouvrir dans l'éditeur"
            onClick={onOpen}
            disabled={!onOpen}
            style={onOpen ? { color: "var(--primary)" } : undefined}
          >
            <Icon name="code" size={12} />
          </button>
        </span>
      </div>
      <pre><code>{highlightRust(text)}</code></pre>
      {preview && isHtml && createPortal(
        <div
          className="cx-preview-scrim"
          onClick={(e) => { if (e.target === e.currentTarget) setPreview(false); }}
        >
          <div className="cx-preview-modal">
            <div className="cx-preview-head">
              <span className="cx-preview-title"><Icon name="image" size={13} /> Aperçu</span>
              <span style={{ flex: 1 }} />
              <button className="cx-tool" title="Fermer" onClick={() => setPreview(false)}><Icon name="x" size={13} /></button>
            </div>
            <iframe className="cx-preview-frame" title="Aperçu HTML" srcDoc={text} sandbox="allow-scripts" />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Image panel — onglet « Image » du Studio média (logique inchangée) ─────
function ImagePanel({ generations, setGenerations }: any) {
  const [prompt, setPrompt] = useState("interface companion mascot in a quiet desktop IDE, luminous glass, precise product illustration");
  const [negative, setNegative] = useState("");
  const [ratio, setRatio] = useState("1:1");
  const [seed, setSeed] = useState(8204);
  const [steps, setSteps] = useState(28);
  const [guidance, setGuidance] = useState(7.5);
  const [model, setModel] = useState(IMAGE_MODEL_PRESETS[0]?.id ?? "comfyui/v1-5-pruned-emaonly.safetensors");
  const [styleKey, setStyleKey] = useState("painterly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<any>(null);
  const brandBoard = useStudioBrandBoard();

  const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16"];
  const styles = ["product", "cinematic", "vector", "anime", "photo", "3d"];
  const currentSrc = imageDisplaySrc(current?.resultUrl);
  const currentPinned = current ? brandBoard.pinnedAssetIds.includes(String(current.id)) : false;

  const generate = async (override?: Partial<{ prompt: string; seed: number }>) => {
    const nextPrompt = override?.prompt ?? prompt;
    const nextSeed = override?.seed ?? seed;
    setBusy(true);
    setCurrent(null);
    setError(null);
    try {
      const resolved = resolveImageProvider(model);
      const config = await loadProviderConfig(resolved.providerId).catch(() => null);
      const configuredBaseUrl = config?.baseUrl?.trim() || config?.endpoint?.trim();
      const apiKey = config?.apiKey?.trim() || undefined;
      const raw = await invoke<any>("image_generate", {
        args: {
          prompt: nextPrompt,
          negative,
          ratio,
          model: resolved.model,
          protocol: resolved.protocol,
          baseUrl: configuredBaseUrl || resolved.baseUrl,
          apiKey,
          seed: nextSeed, steps, guidance, style: styleKey,
        },
      });
      const derivedHue = [...nextPrompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
      const normalized: ImageResult = {
        id:        raw.id       ?? Date.now(),
        prompt:    nextPrompt,
        negative,
        ratio,
        model,
        seed:      nextSeed,
        steps,
        guidance,
        style:     styleKey,
        hue:       typeof raw.hue === "number" ? raw.hue : derivedHue,
        ts:        raw.ts       ?? Date.now(),
        status:    raw.status,
        resultUrl: raw.resultUrl ?? null,
      };
      setCurrent(normalized);
      setGenerations((g: any[]) => [normalized, ...g]);
      if (!normalized.resultUrl) {
        pushToast(`Image: ${normalized.status ?? "aucun fichier reçu"}`, "info", 4500);
      }
      setBusy(false);
    } catch (err) {
      setError(String(err));
      pushToast("Generation image echouee", "error", 5000);
      setBusy(false);
    }
  };

  const makeVariation = () => {
    const nextSeed = Math.floor(Math.random() * 100000);
    setSeed(nextSeed);
    void generate({ seed: nextSeed });
  };

  // Lot stubs-palette (2026-06-10) — les commandes palette (Cmd+Enter /
  // Cmd+Shift+V / Cmd+S sur /image) pilotent les fonctions internes de cette
  // vue via des CustomEvents window-locaux. Ré-abonné à chaque render (cleanup
  // systématique) pour capturer les états frais sans tableau de deps fragile.
  useEffect(() => {
    const onGen = () => {
      if (!busy && prompt.trim()) void generate();
    };
    const onVar = () => {
      if (!busy && current) makeVariation();
    };
    const onPin = () => {
      if (!current?.resultUrl) return;
      togglePinnedAsset(String(current.id));
      pushToast(
        currentPinned ? "Reference marque retiree" : "Reference marque ajoutee",
        "success",
        2400,
      );
    };
    window.addEventListener("shugu:image-generate", onGen);
    window.addEventListener("shugu:image-variation", onVar);
    window.addEventListener("shugu:image-save", onPin);
    return () => {
      window.removeEventListener("shugu:image-generate", onGen);
      window.removeEventListener("shugu:image-variation", onVar);
      window.removeEventListener("shugu:image-save", onPin);
    };
  });

  return (
    <div className="image-shell">
      <div className="image-canvas">
        <div className="image-stage">
          {busy && (
            <div className="loading">
              <div className="ring"></div>
              <div style={{fontFamily:"var(--font-mono)",fontSize:"12px",color:"var(--on-surface-variant)"}}>
                Generating <span style={{color:"var(--primary)"}}>{steps}</span> steps · seed {seed}
              </div>
            </div>
          )}
          {!busy && current && (
            <div className="preview" style={{ aspectRatio: ratioToCss(current.ratio) }}>
              {currentSrc ? (
                <img className="img-real" src={currentSrc} alt={current.prompt} />
              ) : (
                <div className="img-content" style={{background: fallbackGradient(current.hue)}} />
              )}
              {!currentSrc && <div className="img-fallback-note">{current.status ?? "En attente du fichier image"}</div>}
              <div className="img-grain"></div>
              <div style={{position:"absolute", left:14, bottom:14, right:14, display:"flex", gap:8, flexWrap:"wrap"}}>
                <button
                  className="lgb lgb-sm"
                  onClick={() => {
                    copyImageText(current.resultUrl ?? "");
                    pushToast(current.resultUrl ? "Chemin image copie" : "Aucun fichier image a copier", current.resultUrl ? "success" : "info", 2500);
                  }}
                ><Icon name="download" size={12}/> Path</button>
                <button className="lgb lgb-sm" onClick={makeVariation}><Icon name="sparkle" size={12}/> Variations</button>
                <button className="lgb lgb-sm" onClick={() => { copyImageText(current.prompt); pushToast("Prompt copie", "success", 2200); }}><Icon name="copy" size={12}/> Copy prompt</button>
                <button
                  className="lgb lgb-sm"
                  disabled={!current.resultUrl}
                  onClick={() => {
                    togglePinnedAsset(String(current.id));
                    pushToast(currentPinned ? "Reference marque retiree" : "Reference marque ajoutee", "success", 2400);
                  }}
                ><Icon name="image" size={12}/> {currentPinned ? "Unpin" : "Brand ref"}</button>
                <span style={{flex:1}}></span>
                <span className="chip" style={{background:"rgba(0,0,0,0.5)"}}>seed {current.seed}</span>
              </div>
            </div>
          )}
          {!busy && !current && (
            <div className="empty">
              <Icon name="sparkle" size={28}/>
              <div style={{marginTop:10}}>WAITING FOR PROMPT</div>
            </div>
          )}
        </div>
        <div style={{marginTop:14, display:"flex", gap:8, alignItems:"center"}}>
          <span className="chip">{model}</span>
          <span className="chip tertiary">{ratio}</span>
          <span className="chip" style={{textTransform:"none"}}>{styleKey}</span>
          {current?.status && <span className="chip">{current.status}</span>}
          <span style={{flex:1}}></span>
          <span style={{fontSize:11, fontFamily:"var(--font-mono)", color:"var(--on-surface-muted)"}}>{generations.length} in this session</span>
        </div>
      </div>

      <div className="image-controls scroll" style={{paddingLeft:0}}>
        <div className="panel">
          <div className="panel-title">Prompt</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="A dreamy aurora over still water…"/>
          <div className="label-row"><span className="l">Negative</span></div>
          <textarea value={negative} onChange={e => setNegative(e.target.value)} placeholder="blurry, watermark…" style={{minHeight:54}}/>
          {error && <div className="image-error">{error}</div>}
          <button className="lgb lgb-primary lgb-lg" style={{width:"100%", marginTop:14}} onClick={() => void generate()} disabled={busy || !prompt.trim()}>
            <Icon name="sparkle" size={14}/> {busy ? "Generating…" : "Generate"}
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Composition</div>
          <div className="label-row"><span className="l">Ratio</span><span className="v">{ratio}</span></div>
          <div className="ratio-row">
            {ratios.map(r => (
              <button key={r} className={"ratio-btn" + (r === ratio ? " on" : "")} onClick={() => setRatio(r)}>{r}</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Style</span></div>
          <div className="style-chips">
            {styles.map(s => (
              <button key={s} className={"style-chip" + (s === styleKey ? " on" : "")} onClick={() => setStyleKey(s)}>{s}</button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Sampling</div>
          <div className="label-row"><span className="l">Model</span><span className="v">{model}</span></div>
          <div className="image-model-list">
            {IMAGE_MODEL_PRESETS.map(m => (
              <button key={m.id} className={"image-model-btn" + (m.id === model ? " on" : "")} onClick={() => setModel(m.id)}>
                <span>{m.label}</span>
                <small>{m.provider} · {m.meta}</small>
              </button>
            ))}
          </div>
          <input
            className="image-model-custom"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="provider/model ou comfyui/checkpoint.safetensors"
          />
          <div className="label-row"><span className="l">Steps</span><span className="v">{steps}</span></div>
          <input type="range" min={4} max={50} value={steps} onChange={e => setSteps(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Guidance</span><span className="v">{guidance.toFixed(1)}</span></div>
          <input type="range" min={1} max={15} step={0.5} value={guidance} onChange={e => setGuidance(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Seed</span><span className="v">{seed}</span></div>
          <input type="range" min={0} max={99999} value={seed} onChange={e => setSeed(+e.target.value)} className="slider"/>
        </div>

        {generations.length > 0 && (
          <div className="panel">
            <div className="panel-title">Recent</div>
            <div className="image-recent-list">
              {generations.slice(0, 5).map((g: any) => {
                const src = imageDisplaySrc(g.resultUrl);
                return (
                  <button key={g.id} className="image-recent-item" onClick={() => setCurrent(g)}>
                    <span className="image-recent-thumb" style={{ background: src ? undefined : fallbackGradient(g.hue ?? 250) }}>
                      {src && <img src={src} alt="" />}
                    </span>
                    <span className="image-recent-meta">
                      <strong>{g.prompt}</strong>
                      <small>{g.model ?? "model"} · {formatGenerationTime(g.ts)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MiniMax auth resolver — partagé par les onglets Vidéo & Musique ────────
// Vidéo/musique réutilisent la MÊME clé/host que l'image (provider "minimax").
async function resolveMinimaxAuth(): Promise<{ baseUrl: string; apiKey: string }> {
  const config = await loadProviderConfig("minimax").catch(() => null);
  const baseUrl =
    config?.baseUrl?.trim() || config?.endpoint?.trim() || MINIMAX_DEFAULT_BASE_URL;
  const apiKey = config?.apiKey?.trim() || "";
  return { baseUrl, apiKey };
}

// ─── Vidéo (Hailuo) — onglet « Vidéo » du Studio média ──────────────────────
function VideoPanel() {
  const [prompt, setPrompt] = useState(
    "a cozy desktop mascot waving hello, soft volumetric light, smooth camera [Push in]",
  );
  const [model, setModel] = useState(VIDEO_MODEL_PRESETS[0]?.id ?? "MiniMax-Hailuo-02");
  const [resolution, setResolution] = useState<string>("1080P");
  const [duration, setDuration] = useState<number>(6);
  const [firstFrame, setFirstFrame] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ id: string; resultUrl: string | null } | null>(null);

  const currentSrc = imageDisplaySrc(current?.resultUrl);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setCurrent(null);
    try {
      const { baseUrl, apiKey } = await resolveMinimaxAuth();
      if (!apiKey) {
        throw new Error(
          "Clé API MiniMax absente — Réglages → Connexions → MiniMax (colle ta Subscription Key).",
        );
      }
      const raw = await invoke<any>("video_generate", {
        args: {
          prompt,
          model,
          firstFrameImage: firstFrame.trim() || undefined,
          duration,
          resolution,
          baseUrl,
          apiKey,
        },
      });
      setCurrent({ id: String(raw?.id ?? Date.now()), resultUrl: raw?.resultUrl ?? null });
      if (!raw?.resultUrl) pushToast("Vidéo : aucun fichier reçu", "info", 4500);
      else pushToast("Vidéo générée", "success", 3000);
    } catch (err) {
      setError(String(err));
      pushToast("Génération vidéo échouée", "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="image-shell">
      <div className="image-canvas">
        <div className="image-stage">
          {busy && (
            <div className="loading">
              <div className="ring"></div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--on-surface-variant)" }}>
                Génération vidéo… <span style={{ color: "var(--primary)" }}>{resolution}</span> · {duration}s
                <div style={{ marginTop: 6, color: "var(--on-surface-muted)" }}>
                  ça peut prendre 1 à 5 minutes
                </div>
              </div>
            </div>
          )}
          {!busy && current && (
            <div className="preview" style={{ aspectRatio: "16 / 9" }}>
              {currentSrc ? (
                <video className="img-real" src={currentSrc} controls autoPlay loop muted style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />
              ) : (
                <div className="img-fallback-note">Aucun fichier vidéo reçu</div>
              )}
              <div style={{ position: "absolute", left: 14, bottom: 14, right: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="lgb lgb-sm"
                  disabled={!current.resultUrl}
                  onClick={() => {
                    copyImageText(current.resultUrl ?? "");
                    pushToast(current.resultUrl ? "Chemin vidéo copié" : "Aucun fichier", current.resultUrl ? "success" : "info", 2400);
                  }}
                ><Icon name="download" size={12} /> Path</button>
                <button className="lgb lgb-sm" onClick={() => { copyImageText(prompt); pushToast("Prompt copié", "success", 2000); }}><Icon name="copy" size={12} /> Copy prompt</button>
              </div>
            </div>
          )}
          {!busy && !current && (
            <div className="empty">
              <Icon name="sparkle" size={28} />
              <div style={{ marginTop: 10 }}>VIDÉO — DÉCRIS TA SCÈNE</div>
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--on-surface-muted)" }}>3 clips/jour inclus dans ton plan Max</div>
            </div>
          )}
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip">{model}</span>
          <span className="chip tertiary">{resolution}</span>
          <span className="chip">{duration}s</span>
          {firstFrame.trim() && <span className="chip" style={{ textTransform: "none" }}>image→vidéo</span>}
        </div>
      </div>

      <div className="image-controls scroll" style={{ paddingLeft: 0 }}>
        <div className="panel">
          <div className="panel-title">Prompt</div>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Décris la scène… ajoute [Pan left] / [Zoom in] pour la caméra" />
          {error && <div className="image-error">{error}</div>}
          <button className="lgb lgb-primary lgb-lg" style={{ width: "100%", marginTop: 14 }} onClick={() => void generate()} disabled={busy || !prompt.trim()}>
            <Icon name="sparkle" size={14} /> {busy ? "Génération…" : "Générer la vidéo"}
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Format</div>
          <div className="label-row"><span className="l">Résolution</span><span className="v">{resolution}</span></div>
          <div className="ratio-row">
            {VIDEO_RESOLUTIONS.map((r) => (
              <button key={r} className={"ratio-btn" + (r === resolution ? " on" : "")} onClick={() => setResolution(r)}>{r}</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Durée</span><span className="v">{duration}s</span></div>
          <div className="ratio-row">
            {VIDEO_DURATIONS.map((d) => (
              <button key={d} className={"ratio-btn" + (d === duration ? " on" : "")} onClick={() => setDuration(d)}>{d}s</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Image de départ (image→vidéo)</span></div>
          <input className="image-model-custom" value={firstFrame} onChange={(e) => setFirstFrame(e.target.value)} placeholder="URL https://… ou data:image/… (optionnel)" />
        </div>

        <div className="panel">
          <div className="panel-title">Modèle</div>
          <div className="label-row"><span className="l">Modèle</span><span className="v">{model}</span></div>
          <div className="image-model-list">
            {VIDEO_MODEL_PRESETS.map((m) => (
              <button key={m.id} className={"image-model-btn" + (m.id === model ? " on" : "")} onClick={() => setModel(m.id)}>
                <span>{m.label}</span>
                <small>MiniMax · {m.meta}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Musique — onglet « Musique » du Studio média ───────────────────────────
function MusicPanel() {
  const [prompt, setPrompt] = useState("upbeat lo-fi hip-hop, warm vinyl, mellow piano, relaxed tempo");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [model, setModel] = useState(MUSIC_MODEL_PRESETS[0]?.id ?? "music-2.6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ id: string; resultUrl: string | null } | null>(null);

  const currentSrc = imageDisplaySrc(current?.resultUrl);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setCurrent(null);
    try {
      const { baseUrl, apiKey } = await resolveMinimaxAuth();
      if (!apiKey) {
        throw new Error(
          "Clé API MiniMax absente — Réglages → Connexions → MiniMax (colle ta Subscription Key).",
        );
      }
      const raw = await invoke<any>("music_generate", {
        args: {
          prompt,
          lyrics: instrumental ? undefined : lyrics,
          instrumental,
          model,
          baseUrl,
          apiKey,
        },
      });
      setCurrent({ id: String(raw?.id ?? Date.now()), resultUrl: raw?.resultUrl ?? null });
      if (!raw?.resultUrl) pushToast("Musique : aucun fichier reçu", "info", 4500);
      else pushToast("Morceau généré", "success", 3000);
    } catch (err) {
      setError(String(err));
      pushToast("Génération musique échouée", "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="image-shell">
      <div className="image-canvas">
        <div className="image-stage">
          {busy && (
            <div className="loading">
              <div className="ring"></div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--on-surface-variant)" }}>
                Composition en cours… <span style={{ color: "var(--primary)" }}>{model}</span>
                <div style={{ marginTop: 6, color: "var(--on-surface-muted)" }}>~30–60 s</div>
              </div>
            </div>
          )}
          {!busy && current && (
            <div className="preview" style={{ aspectRatio: "16 / 9", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, padding: 24 }}>
              <Icon name="sparkle" size={36} />
              {currentSrc ? (
                <audio src={currentSrc} controls autoPlay style={{ width: "100%" }} />
              ) : (
                <div className="img-fallback-note">Aucun fichier audio reçu</div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  className="lgb lgb-sm"
                  disabled={!current.resultUrl}
                  onClick={() => {
                    copyImageText(current.resultUrl ?? "");
                    pushToast(current.resultUrl ? "Chemin audio copié" : "Aucun fichier", current.resultUrl ? "success" : "info", 2400);
                  }}
                ><Icon name="download" size={12} /> Path</button>
              </div>
            </div>
          )}
          {!busy && !current && (
            <div className="empty">
              <Icon name="sparkle" size={28} />
              <div style={{ marginTop: 10 }}>MUSIQUE — DÉCRIS LE STYLE</div>
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--on-surface-muted)" }}>inclus dans le quota partagé de ton plan</div>
            </div>
          )}
        </div>
      </div>

      <div className="image-controls scroll" style={{ paddingLeft: 0 }}>
        <div className="panel">
          <div className="panel-title">Style / ambiance</div>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="ex. epic orchestral, cinematic, rising tension…" />
          {error && <div className="image-error">{error}</div>}
          <button className="lgb lgb-primary lgb-lg" style={{ width: "100%", marginTop: 14 }} onClick={() => void generate()} disabled={busy || !prompt.trim() || (!instrumental && !lyrics.trim())}>
            <Icon name="sparkle" size={14} /> {busy ? "Composition…" : "Générer le morceau"}
          </button>
        </div>

        <div className="panel">
          <div className="panel-title">Paroles</div>
          <div className="style-chips">
            <button className={"style-chip" + (instrumental ? " on" : "")} onClick={() => setInstrumental(true)}>Instrumental</button>
            <button className={"style-chip" + (!instrumental ? " on" : "")} onClick={() => setInstrumental(false)}>Chanté</button>
          </div>
          {!instrumental && (
            <>
              <div className="label-row"><span className="l">Paroles (requis pour le chant)</span></div>
              <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} placeholder="Écris les paroles…" style={{ minHeight: 90 }} />
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Modèle</div>
          <div className="label-row"><span className="l">Modèle</span><span className="v">{model}</span></div>
          <div className="image-model-list">
            {MUSIC_MODEL_PRESETS.map((m) => (
              <button key={m.id} className={"image-model-btn" + (m.id === model ? " on" : "")} onClick={() => setModel(m.id)}>
                <span>{m.label}</span>
                <small>MiniMax · {m.meta}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Studio média — onglets Image / Vidéo / Musique sur la route /image ─────
// Conserve la signature publique d'ImageView (props image) attendue par
// routes/image.tsx : seul l'onglet « Image » consomme generations/setGenerations.
export function ImageView({ generations, setGenerations }: any) {
  const [tab, setTab] = useState<"image" | "video" | "music">("image");
  const tabs: { id: "image" | "video" | "music"; label: string; icon: string }[] = [
    { id: "image", label: "Image", icon: "image" },
    { id: "video", label: "Vidéo", icon: "sparkle" },
    { id: "music", label: "Musique", icon: "sparkle" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 6, padding: "10px 0 12px", flex: "none" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"lgb lgb-sm" + (t.id === tab ? " lgb-primary" : "")}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={12} /> {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "image" && <ImagePanel generations={generations} setGenerations={setGenerations} />}
        {tab === "video" && <VideoPanel />}
        {tab === "music" && <MusicPanel />}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────
export function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

// Lightweight Rust tokenizer that emits JSX (no innerHTML). XSS-safe.
const RUST_KEYWORDS = new Set(["fn","let","mut","use","pub","struct","impl","return","if","else","match","Err","Ok","Some","None","Result","String","i32","u32","f32","bool"]);

type Token = { cls: string | null; text: string };

function tokenizeRust(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  const push = (cls: string | null, text: string) => { if (text) tokens.push({ cls, text }); };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < n && src[j] !== "\n") j++;
      push("c", src.slice(i, j)); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      push("s", src.slice(i, j)); i = j; continue;
    }
    if (c === "#" && src[i + 1] === "[") {
      let j = i + 2, depth = 1;
      while (j < n && depth > 0) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        j++;
      }
      push("p", src.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < n && /[0-9.]/.test(src[j])) j++;
      push("n", src.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (RUST_KEYWORDS.has(word)) push("k", word);
      else if (src[j] === "(") push("f", word);
      else push(null, word);
      i = j; continue;
    }
    let j = i;
    while (j < n && !/[\/"#0-9A-Za-z_]/.test(src[j])) j++;
    push(null, src.slice(i, j || i + 1));
    i = Math.max(j, i + 1);
  }
  return tokens;
}

export function highlightRust(text: string): React.ReactNode[] {
  return tokenizeRust(text).map((t, idx) =>
    t.cls ? <span key={idx} className={t.cls}>{t.text}</span> : <React.Fragment key={idx}>{t.text}</React.Fragment>
  );
}
