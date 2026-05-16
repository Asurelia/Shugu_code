// Shugu Forge — FloatChat (mascot mini-chat).
//
// The mascot window's primary content: a floating chibi mascot + a compact
// chat panel that docks beside it. Pos/drag/snap/edge state lives in
// useFloatPosition; mode (closed/compact/full) lives in useFloatMode; mood
// derivation lives in useChibiMood. FloatChat owns chat-specific state
// (msgs, busy, input, tabs, history list) and composes the hooks.
//
// Host coupling (mascot.tsx pushes these props down):
//   - disableInternalDrag: silences intra-window drag (the host drags the
//     whole OS window instead).
//   - forceSide: overrides the side detection (chibi placement vs window
//     midline) when the host knows the window's monitor side.
//   - freezePos: prevents any effect from touching pos. The host slides
//     the OS window on snap; the chibi must not visually teleport inside.
//   - forceEdge: pushed by the host on screen-edge snap so the chibi
//     switches to the peek-pose sprite and the chat panel hides.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import {
  useMessages,
  useActiveConv,
  useActiveModel,
  sendChatMessage,
  createConversation,
} from "@/features/chat/chat-sync";
import { db } from "@/lib/db";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { useChibiMood } from "@/features/mascot/useChibiMood";
import { Chibi } from "@/features/mascot/Chibi";
import { useFloatPosition, type FloatEdge } from "@/features/floating/useFloatPosition";
import { useFloatMode } from "@/features/floating/useFloatMode";

// Relative time format for chibi history rows (handoff helper).
function fmtAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

export interface FloatChatProps {
  pinnedAnno?: any;
  clearPinned?: () => void;
  disableInternalDrag?: boolean;
  forceSide?: "left" | "right";
  freezePos?: boolean;
  forceEdge?: FloatEdge | undefined;
}

export function FloatChat({
  pinnedAnno,
  clearPinned,
  disableInternalDrag,
  forceSide,
  freezePos,
  forceEdge,
}: FloatChatProps) {
  // Position + edge + drag handlers (intra-window) — see useFloatPosition.
  const {
    pos,
    side,
    edge,
    dragging,
    movedRef,
    onAvatarMouseDown,
    onContextMenu,
    clearEdge,
  } = useFloatPosition({ disableInternalDrag, forceSide, freezePos, forceEdge });

  // Panel visibility state machine (closed/compact/full).
  const { mode, setMode, toggleClosed, toggleFull } = useFloatMode("compact");

  const [speech, setSpeech] = useState({ visible: true, text: "Hey · clic pour parler" });

  // hasKey is derived from live model discovery: at least one configured
  // provider responded with at least one model = we have somewhere to talk to.
  const { data: discoveredModels } = useDiscoveredModels();
  const hasKey = discoveredModels.length > 0;

  // The selected model is shared with the main IDE composer via chat-sync's
  // useActiveModel (localStorage + Tauri event). Either window's pick applies
  // to both.
  const [model] = useActiveModel();

  // Messages live in SQLite and stream in from chat-sync. This window also
  // writes via the new-convo / load-history actions below.
  const [activeConv, setActiveConv] = useActiveConv();
  const { data: msgs } = useMessages(activeConv);
  const [lastMsgCount, setLastMsgCount] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasUnread, setHasUnread] = useState(false); // LLM reply arrived while tucked / closed

  // Tab switches the .float-history-shell content: "feed" → current convo,
  // "history" → list of past conversations (loaded from SQLite).
  const [tab, setTab] = useState<"feed" | "history">("feed");
  const [historyConvs, setHistoryConvs] = useState<{ id: string; title: string; ts: number }[]>([]);
  const [histRefresh, setHistRefresh] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);

  // Detect "new AI message landed while tucked/closed" so the chibi pops
  // the peek_open expression.
  useEffect(() => {
    if (msgs.length > lastMsgCount) {
      const newest = msgs[msgs.length - 1];
      if (newest?.role === "ai" && (mode !== "full" || edge)) {
        setHasUnread(true);
      }
    }
    setLastMsgCount(msgs.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);

  // History tab: load conversations (excluding the active one) lazily — only
  // when the history tab is visible and the panel is open. In web mode
  // (no Tauri), db.conversations.list() returns [] and the empty-state UI
  // takes over.
  useEffect(() => {
    if (mode !== "full" || tab !== "history") return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await db.conversations.list();
        if (cancelled) return;
        const mapped = rows
          .filter((r: any) => r.id !== activeConv && !r.archived)
          .map((r: any) => ({
            id: r.id as string,
            title: (r.title as string) || "Untitled",
            ts: (r.updated_at as number) ?? Date.now(),
          }));
        setHistoryConvs(mapped);
      } catch {
        if (!cancelled) setHistoryConvs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, tab, activeConv, histRefresh]);

  // Mood derivation + manual override + idle ticker — see useChibiMood.
  const { mood, cycleMood, bumpInteract } = useChibiMood({
    edge,
    hasUnread,
    busy,
    hasKey,
    pinnedAnno,
    hasMessages: msgs.length > 0,
  });

  // newConvo: only fork a fresh row when the current convo has messages —
  // avoids polluting SQLite with empty rows on rapid "+" clicks.
  const newConvo = async () => {
    if (msgs.length === 0) {
      setTab("feed");
      setMode("full");
      return;
    }
    const id = await createConversation("New chat");
    if (id) setActiveConv(id);
    setInput("");
    bumpInteract();
    setTab("feed");
    setMode("full");
    setHistRefresh(n => n + 1);
  };
  const loadConvo = (id: string) => {
    setActiveConv(id);
    setTab("feed");
    setMode("full");
    bumpInteract();
  };
  const deleteConvo = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try { await db.conversations.remove(id); } catch { /* no-op */ }
    setHistoryConvs(h => h.filter(c => c.id !== id));
    setHistRefresh(n => n + 1);
  };

  useEffect(() => {
    if (pinnedAnno) {
      setSpeech({ visible: true, text: `Tu as épinglé : "${(pinnedAnno.label || pinnedAnno.text || "").slice(0, 60)}"` });
      if (mode === "closed") setMode("compact");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedAnno]);

  useEffect(() => {
    if (!speech.visible) return;
    const t = setTimeout(() => setSpeech(s => ({ ...s, visible: false })), 5500);
    return () => clearTimeout(t);
  }, [speech.text, speech.visible]);

  useEffect(() => {
    if (mode === "full" && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [msgs, mode]);

  const send = () => {
    const t = input.trim();
    if (!t || !hasKey) return;
    setInput("");
    setBusy(true);
    setMode("full");
    bumpInteract();
    // sendChatMessage handles both user + AI message persistence in SQLite
    // and broadcasts chat://messages-changed — useMessages picks up both
    // events and re-renders the history feed. The main IDE's ChatView sees
    // the same updates.
    void (async () => {
      try {
        await sendChatMessage(activeConv, t, model);
      } finally {
        setBusy(false);
        bumpInteract();
      }
    })();
  };

  // Clear the unread flag once the user actually sees the conversation
  // (panel expanded to "full") or starts typing again.
  useEffect(() => {
    if (mode === "full" && hasUnread) setHasUnread(false);
  }, [mode, hasUnread]);
  useEffect(() => {
    if (input && hasUnread) setHasUnread(false);
  }, [input, hasUnread]);

  const onAvatarClick = (e: React.MouseEvent) => {
    if (movedRef.current) return;
    if (e.altKey) { cycleMood(); return; }
    if (edge) {
      clearEdge();
      if (mode === "closed") setMode("compact");
      return;
    }
    toggleClosed();
  };

  const shellClass = [
    "float-shell",
    "side-" + side,
    mode === "closed" ? "closed" : "",
    mode === "compact" ? "compact" : "",
    mode === "full" ? "full" : "",
    edge ? "edge-hidden edge-hidden-" + edge : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClass} style={{ left: pos.x, top: pos.y }}>
      <div className="float-cluster">
        {speech.visible && mode !== "closed" && !edge && (
          <div className="float-speech" onClick={() => setSpeech(s => ({ ...s, visible: false }))}>
            {speech.text}
          </div>
        )}
        <button
          className="float-avatar-btn"
          onMouseDown={onAvatarMouseDown}
          onClick={onAvatarClick}
          onDoubleClick={toggleFull}
          onContextMenu={onContextMenu}
          title={edge
            ? "Cliquer pour ramener"
            : (mode === "closed"
              ? "Cliquer pour ouvrir · drag · alt+clic pour changer d'humeur"
              : "Cliquer pour fermer · double pour étendre · drag pour déplacer · alt+clic pour humeur")}
        >
          <span className="float-avatar-orbit">
            <span className="float-avatar-flip">
              <Chibi size={240} mood={mood}/>
            </span>
          </span>
          <span className="float-avatar-glow"></span>
        </button>
        {edge && <span className="float-edge-tip">Click to bring back</span>}
      </div>

      <div className="float-body">
        {mode === "full" && (
          <div className="float-history-shell">
            {tab === "feed" ? (
              <div className="float-history" ref={historyRef}>
                {msgs.length === 0 && (
                  <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                    No conversation yet — say something.
                  </div>
                )}
                {msgs.map((m) => (
                  <div key={String(m.id)} className={"fm " + (m.role === "user" ? "you" : "ai")}>
                    {m.text ?? m.body ?? ""}
                  </div>
                ))}
              </div>
            ) : (
              <div className="float-history-list">
                {historyConvs.length === 0 ? (
                  <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                    Pas encore d'historique.
                  </div>
                ) : (
                  historyConvs.map((h) => (
                    <div key={h.id} className="fhl-item" onClick={() => loadConvo(h.id)}>
                      <div className="fhl-info">
                        <span className="t">{h.title}</span>
                        <span className="m">{fmtAgo(h.ts)}</span>
                      </div>
                      <button className="fhl-del" onClick={(e) => deleteConvo(h.id, e)} title="Supprimer">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {mode === "full" && (
          <div className="float-tabs">
            <button className={"float-tab" + (tab === "feed" ? " on" : "")} onClick={() => setTab("feed")} title="Chat">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>Chat</span>
              {msgs.length > 0 && <span className="float-tab-count">{msgs.length}</span>}
            </button>
            <button className="float-tab new" onClick={() => { void newConvo(); }} title="Nouvelle conversation">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>Nouveau</span>
            </button>
            <button className={"float-tab" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")} title="Historique">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span>Historique</span>
              {historyConvs.length > 0 && <span className="float-tab-count">{historyConvs.length}</span>}
            </button>
          </div>
        )}

        <div className="float-panel cchrome-naked cstyle-pill csize-thin csend-kbd cfoot-hidden">
          {pinnedAnno && (
            <div className="float-pinned-note">
              pinned
              <span className="target">"{pinnedAnno.label || pinnedAnno.text}"</span>
              <span className="x" onClick={clearPinned}>×</span>
            </div>
          )}

          <div className="float-composer">
            <div style={{position:"relative", minWidth:0}}>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={busy ? "…" : "Message Shugu…"}
                rows={1}
              />
              {!input && !hasKey && (
                <button
                  className="float-api-badge"
                  type="button"
                  title="Aucun provider configuré — ouvre Settings → Connections dans la fenêtre principale"
                  onClick={async () => {
                    // Cross-window deep-link to Settings → Connections. Each
                    // step is best-effort: if Tauri is unavailable (web mode)
                    // the button just no-ops.
                    try {
                      const eventMod = await import("@tauri-apps/api/event");
                      await eventMod.emit("app://navigate", { path: "/settings/connections" });
                    } catch (err) {
                      console.warn("[chibi] emit navigate failed", err);
                    }
                    try {
                      const winMod = await import("@tauri-apps/api/webviewWindow");
                      const main = await winMod.WebviewWindow.getByLabel("main");
                      if (main) {
                        await main.show();
                        await main.unminimize();
                        await main.setFocus();
                      }
                    } catch (err) {
                      console.warn("[chibi] focus main window failed", err);
                    }
                  }}
                >
                  Set API key
                </button>
              )}
            </div>
            <div className="float-actions-col">
              <span className={"float-kbd-hint" + (input.trim() && hasKey && !busy ? " ready" : "")} onClick={send} title="Send (Enter)">
                <span className="k">↵</span>
              </span>
              <button className="float-icon-btn attach" title="Attach a file or screenshot">
                <Icon name="attach" size={13}/>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
