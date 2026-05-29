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
import { useMessages, sendChatMessage, useActiveModel } from "./chat-sync";
import { ModelPicker } from "@/features/panels/panels";
import { resolveImageProvider } from "@/lib/imageProviders";
import { revealAgent } from "@/lib/agents";
import { useAgentDefs } from "@/features/agents/agentDefsQueries";
import { useMessageDisplay } from "./useMessageDisplay";
import { useShell } from "@/routes/shell-context";
import { CodeMirrorEditor } from "@/features/code/CodeMirrorEditor";
import { GitDiffView } from "@/features/code/DiffView";
import { ContextBubble } from "@/features/context-cards/ContextBubble";
import { useGitBranches } from "@/features/git/queries";
import { useWorkspaceChanges } from "@/features/git/useWorkspaceChanges";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { fsKeys } from "@/features/fs/keys";
import type { Message, MessageAction } from "@/lib/types";

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
  ts: string;
  status?: string;
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
}: {
  activeConv: string;
  model?: string;
  onOpenSnippet?: (code: string, lang: string) => void;
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

  const navigate = useNavigate();
  const { openFile, fileContents, setFileContents, editorPrefs, compareFile, setCompareFile } = useShell();

  // Phase 2 — Chat→Editor handoff. When a file is opened from an action card,
  // we reveal an in-chat split (chat left, CodeMirror right) instead of
  // leaving the chat view. `splitFile` null = no split.
  const [splitFile, setSplitFile] = useState<string | null>(null);

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

  // Most-recent agent-relay message id — the live workspace-diff action card
  // is attached only to it (avoids implying stale per-message attribution on
  // historical turns).
  const latestAgentId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].viaAgent) return messages[i].id;
    }
    return null;
  })();

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, typing, chatStream.streaming, chatStream.partial, chatStream.partialReasoning]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
      );
    } finally {
      setTyping(false);
      chatStream.stop();
    }
  }, [input, pendingImage, model, activeConv, chatStream, enabledAgents]);

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
  const handleOpenFile = useCallback((path: string) => {
    setCompareFile(null); // opening a file for editing supersedes any open diff
    void (async () => {
      await openFile(path);
      setSplitFile(path);
    })();
  }, [openFile, setCompareFile]);

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
          <button className="cx-tool" title="Joindre une image" onClick={() => fileInputRef.current?.click()}>
            <Icon name="attach" size={15} />
          </button>
          <button
            className={"cx-tool" + (mode === "image" ? " on" : "")}
            onClick={() => setMode((m) => (m === "image" ? "chat" : "image"))}
            title="Mode image"
          >
            <Icon name="image" size={15} />
          </button>
          <button className="cx-tool" title="Voix"><Icon name="mic" size={15} /></button>
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
      </div>
      <div className="cx-ctx-row">
        <button className="cx-chip status" title="Accès au système de fichiers (Tauri)">
          <span className="dot" />
          Accès complet
        </button>
        <button className="cx-chip" title="Espace de travail">
          <Icon name="folder" size={11} />
          {cwd}
        </button>
        {branch && (
          <button className="cx-chip branch" title="Branche git courante">
            <span className="dot" />
            {branch}
          </button>
        )}
        <div className="cx-chip-spacer" />
        <button className="cx-chip" title="Exécution locale (local-first)">
          <Icon name="shield" size={11} />
          local
        </button>
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
                  isLatestAgent={m.id === latestAgentId}
                  onOpenFile={handleOpenFile}
                  onOpenSnippet={onOpenSnippet}
                />
              ))}
              {typing && (
                <div className="cx-msg ai">
                  <div className="cx-meta">
                    <span className="mark ai"><Icon name="sparkle" size={11} /></span>
                    <span className="who">Shugu</span>
                    <span className="sep">·</span>
                    <span className="ts">en train de travailler…</span>
                  </div>
                  {chatStream.streaming && (chatStream.partial || chatStream.partialReasoning) ? (
                    <div className="cx-body">
                      {chatStream.partialReasoning && (
                        <ThinkBlock open text={chatStream.partialReasoning} />
                      )}
                      {chatStream.partial && <p>{chatStream.partial}</p>}
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
      <ContextBubble convId={activeConv} onOpenFile={handleOpenFile} />
    </div>
  );

  if (!splitFile && !compareFile) return chatMain;

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
              <button className="lgb lgb-sm" onClick={openFullEditor} title="Ouvrir en plein écran">
                <Icon name="code" size={11} /> Plein écran
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

// ─── Per-message renderer ───────────────────────────────────
function CxMessage({
  m,
  model,
  isLatestAgent,
  onOpenFile,
  onOpenSnippet,
}: {
  m: Message;
  model: string;
  isLatestAgent: boolean;
  onOpenFile: (path: string) => void;
  onOpenSnippet?: (code: string, lang: string) => void;
}) {
  const { displayBody, liveReasoning, isStreamingAgent, imageDataUrl } = useMessageDisplay(m);

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
        {m.viaAgent && m.agentId && (
          <span className="via-agent" onClick={() => void revealAgent(m.agentId!)} title="Voir la trace de l'orchestrateur">
            via orchestrator
          </span>
        )}
      </div>

      {isStreamingAgent && liveReasoning && !m.reasoning && <ThinkBlock open text={liveReasoning} />}
      {m.reasoning && <ThinkBlock text={m.reasoning} label={`Thinking (${m.reasoning.length} chars)`} />}

      <div className="cx-body">
        {imageDataUrl ? (
          <img src={imageDataUrl} alt="image générée" />
        ) : (
          <>
            {displayBody && renderProse(displayBody)}
            {m.code && (
              <CodeBlock
                lang={m.code.lang}
                text={m.code.text}
                onOpen={onOpenSnippet ? () => onOpenSnippet(m.code!.text, m.code!.lang) : undefined}
              />
            )}
            {m.action && <ActionCard action={m.action} onOpenFile={onOpenFile} />}
            {isLatestAgent && !m.action && <WorkspaceDiffCard onOpenFile={onOpenFile} />}
          </>
        )}
        <div className="cx-react">
          <button title="Copier" onClick={() => copyText(displayBody || m.body || m.text || "")}>
            <Icon name="copy" size={12} />
          </button>
        </div>
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

// Render markdown prose: split on blank lines into paragraphs, render inline
// `code` spans as Celestial-Veil code chips. No innerHTML.
function renderProse(text: string): React.ReactNode {
  const paras = text.split(/\n{2,}/);
  return paras.map((para, i) => <p key={i}>{renderInlineCode(para)}</p>);
}

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
            <div key={f.name} className="cx-action-file" onClick={() => onOpenFile(f.name)} title="Ouvrir dans l'éditeur">
              <span className={"dot " + f.st} />
              <span className="name">{f.name}</span>
              <span className="stats">
                <span className="add">+{f.add}</span>
                <span className="rem">−{f.rem}</span>
              </span>
              <span className="open-hint">Ouvrir ›</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Live workspace-diff card: real working-tree changes from git, attached to
// the latest agent-relay message. Files are clickable → editor. Renders
// nothing outside a repo or with a clean tree.
function WorkspaceDiffCard({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const { files, isRepo } = useWorkspaceChanges();
  const [open, setOpen] = useState(true);
  if (!isRepo || files.length === 0) return null;
  return (
    <div className="cx-action">
      <div className="cx-action-head">
        <div className="cx-action-ico"><Icon name="diff" size={15} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cx-action-title">{files.length} fichier{files.length > 1 ? "s" : ""} modifié{files.length > 1 ? "s" : ""}</div>
          <div className="cx-action-sub"><span style={{ opacity: 0.6 }}>espace de travail · git</span></div>
        </div>
        <div className="cx-action-actions">
          <button className="cx-action-btn" onClick={() => setOpen((o) => !o)}>{open ? "Masquer" : "Détails"}</button>
        </div>
      </div>
      {open && (
        <div className="cx-action-files">
          {files.map((f) => (
            <div key={f.name} className="cx-action-file" onClick={() => onOpenFile(f.name)} title="Ouvrir dans l'éditeur">
              <span className={"dot " + f.st} />
              <span className="name">{f.name}</span>
              <span className="open-hint">Ouvrir ›</span>
            </div>
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
}: {
  lang: string;
  text: string;
  onOpen?: () => void;
}) {
  const [preview, setPreview] = useState(false);
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

// ─── Image view (dedicated) — unchanged data wiring ─────────
export function ImageView({ generations, setGenerations }: any) {
  const [prompt, setPrompt] = useState("celestial veil over a quiet ocean at dusk, soft purples and cyan, painterly");
  const [negative, setNegative] = useState("");
  const [ratio, setRatio] = useState("1:1");
  const [seed, setSeed] = useState(8204);
  const [steps, setSteps] = useState(28);
  const [guidance, setGuidance] = useState(7.5);
  const [model, setModel] = useState("flux.1-veil");
  const [styleKey, setStyleKey] = useState("painterly");
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<any>(null);

  const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16"];
  const styles = ["painterly", "cinematic", "vector", "anime", "photo", "3d"];

  const generate = async () => {
    setBusy(true);
    setCurrent(null);
    try {
      const { protocol, baseUrl, model: realModel } = resolveImageProvider(model);
      const raw = await invoke<any>("image_generate", {
        prompt, negative, ratio, model: realModel, protocol, baseUrl,
        seed, steps, guidance, style: styleKey,
      });
      const derivedHue = [...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
      const normalized: ImageResult = {
        id:        raw.id       ?? Date.now(),
        prompt,
        ratio,
        model,
        seed,
        steps,
        guidance,
        style:     styleKey,
        hue:       typeof raw.hue === "number" ? raw.hue : derivedHue,
        ts:        raw.ts       ?? nowTime(),
        status:    raw.status,
        resultUrl: raw.resultUrl ?? null,
      };
      setCurrent(normalized);
      setGenerations((g: any[]) => [normalized, ...g]);
      setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  const bg = current
    ? `radial-gradient(circle at 30% 30%, hsl(${current.hue} 80% 70%) 0%, transparent 50%), radial-gradient(circle at 70% 70%, hsl(${(current.hue+60)%360} 80% 60%) 0%, transparent 50%), radial-gradient(circle at 60% 30%, hsl(${(current.hue+120)%360} 80% 60%) 0%, transparent 55%), linear-gradient(135deg, #2a1437 0%, #0d0d18 100%)`
    : undefined;

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
            <div className="preview">
              <div className="img-content" style={{background: bg}}></div>
              <div className="img-grain"></div>
              <div style={{position:"absolute", left:14, bottom:14, right:14, display:"flex", gap:8}}>
                <button className="lgb lgb-sm"><Icon name="download" size={12}/> Save</button>
                <button className="lgb lgb-sm"><Icon name="sparkle" size={12}/> Variations</button>
                <button className="lgb lgb-sm"><Icon name="copy" size={12}/> Copy prompt</button>
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
          <button className="lgb lgb-primary lgb-lg" style={{width:"100%", marginTop:14}} onClick={generate} disabled={busy}>
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
          <div className="ratio-row" style={{flexDirection:"column", gap:6}}>
            {["flux.1-veil", "sdxl-celestial", "shugu-lcm-fast"].map(m => (
              <button key={m} className={"ratio-btn" + (m === model ? " on" : "")} style={{textAlign:"left", padding:"8px 12px"}} onClick={() => setModel(m)}>{m}</button>
            ))}
          </div>
          <div className="label-row"><span className="l">Steps</span><span className="v">{steps}</span></div>
          <input type="range" min={4} max={50} value={steps} onChange={e => setSteps(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Guidance</span><span className="v">{guidance.toFixed(1)}</span></div>
          <input type="range" min={1} max={15} step={0.5} value={guidance} onChange={e => setGuidance(+e.target.value)} className="slider"/>
          <div className="label-row"><span className="l">Seed</span><span className="v">{seed}</span></div>
          <input type="range" min={0} max={99999} value={seed} onChange={e => setSeed(+e.target.value)} className="slider"/>
        </div>
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
