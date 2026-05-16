// Shugu Forge — FloatChat (mascot mini-chat) + re-exports for the components
// that used to live here (Dock, ContextMenu, AccountDropdown, ModelPicker,
// AnnotationLayer, Connections, Profile, Chibi). External consumers keep
// their existing import path until each is migrated to its dedicated module.
// Ported from panels.jsx (60KB original); the legacy comment lives on as a
// reminder of how much code has since been split into proper homes.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { invoke, listen } from "@/lib/tauri";
import { useMessages, useActiveConv, useActiveModel, sendChatMessage, createConversation } from "@/features/chat/chat-sync";
import { db } from "@/lib/db";
import { useDiscoveredModels } from "@/lib/modelDiscovery";
import { useChibiMood } from "@/features/mascot/useChibiMood";
import { Chibi, type ChibiMood } from "@/features/mascot/Chibi";
// Reuse import for FloatChat — same hook, single source of truth for the
// "are any providers actually configured?" question used by both the
// ModelPicker popover and the chibi's mood/send-enabled gating.
// `invalidateDiscovery` is called by ConnCard and AddProviderModal so the
// model picker in every window picks up newly-saved keys without a manual
// refresh.

// Relative time format for chibi history rows (handoff helper).
function fmtAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

// ─── Dock (moved) ───────────────────────────────────────────
// DockWorkspace + DockTerminal + DockAgentChat + DockOutput + DockProblems
// live in their own module now, along with their internal helpers and the
// xterm theme. Re-exported so RootLayout's existing imports keep working.
export {
  DockWorkspace,
  DockTerminal,
  DockAgentChat,
  DockOutput,
  DockProblems,
} from "@/features/dock/Dock";


// ContextMenu — moved to its own module. Re-exported so RootLayout's
// existing import keeps working until migrated to the direct path.
export { ContextMenu } from "@/features/panels/ContextMenu";

// AccountDropdown — moved to its own module. Re-exported for RootLayout.
export { AccountDropdown } from "@/features/panels/AccountDropdown";

// ModelPicker — moved to its own module. Re-exported so existing
// imports of ModelPicker from @/features/panels/panels keep working
// until consumers are migrated to @/features/panels/ModelPicker.
export { ModelPicker } from "@/features/panels/ModelPicker";

// Mascot — Chibi component + ChibiMood type live in their own module now.
// Imported above; re-exported here so existing external imports
// (e.g. mascot.tsx, kit.jsx) keep working until they migrate to
// @/features/mascot/Chibi directly.
export { Chibi, type ChibiMood };

// ─── Floating mini-chat (space-agent style) ─────────────────
// `disableInternalDrag`: when true, the chibi avatar's mousedown becomes a
// no-op for drag purposes — click-to-toggle still works. The host (e.g. the
// mascot window in src/mascot.tsx) is then free to install its own
// mousedown handler that moves the OS window instead of repositioning the
// chibi inside the viewport.
// `forceSide`: when provided, overrides the default left/right detection
// (which relies on the chibi's intra-window pos.x). Used by the mascot
// window to flip the chibi + dock the chat panel based on where the WINDOW
// sits on the monitor, not where the chibi is inside the window.
// `freezePos`: when true, NO useEffect touches the chibi's intra-window
// position. Used by the mascot window so a screen-edge snap can slide the
// OS window into place without ever repositioning the chibi inside the
// frame — keeps the chibi visually anchored to wherever the user dropped
// it, no "teleport" feel.
// `forceEdge`: when "left"|"right"|"top"|"bottom", the chibi switches to
// the matching peek pose (gripping the screen edge sprite) and the chat
// panel hides — the shimeji-style "tucked at the edge" state. Pass null
// to un-tuck (e.g. before the user drags away). The host (mascot.tsx)
// sets this on a screen-edge snap so the snap is VISUALLY confirmed by
// the chibi's pose change.
export function FloatChat({ pinnedAnno, clearPinned, disableInternalDrag, forceSide, freezePos, forceEdge }: any) {
  const [mode, setMode] = useState<"closed" | "compact" | "full">("compact");
  // Mood state + derivation + idle ticker are encapsulated in useChibiMood
  // (src/features/mascot/useChibiMood.ts). The hook owns moodOverride,
  // lastInteract, and the 5s ticker — FloatChat only feeds it inputs and
  // calls bumpInteract() from user-interaction handlers.
  const [pos, setPos] = useState(() => {
    // Default: CENTER of viewport, both axes. With FloatChat now only used
    // in the mascot window (M2), the wide-enough mascot frame (≥ 844 px)
    // ensures the chat panel fits flush on EITHER side of the chibi —
    // critical when the host (mascot.tsx) flips forceSide based on which
    // half of the monitor the chibi visible body sits on.
    const w = 156, h = 156;
    return {
      x: Math.round(window.innerWidth  / 2 - w / 2),
      y: Math.round(window.innerHeight / 2 - h / 2),
    };
  });
  // Coupling with the mascot host:
  //   - freezePos=true  → never touch pos (mascot mode: window slides for snap)
  //   - freezePos=false + forceSide set → M3-v2 slide pos.x to side
  //
  // The "freeze" mode trades chat-panel clipping risk for visual stability:
  // when the user drops the chibi loosely on the left half of the screen
  // but the chibi is still rendered at the right of the window, the chat
  // panel may extend past the window's right edge. That's the next thing to
  // address but it's a SOFT bug; the previous "anchor preset" behaviour had
  // a HARD bug where the chibi visually jumped on every snap, which felt
  // like a teleport.
  useEffect(() => {
    if (freezePos) return;
    if (forceSide === "left" || forceSide === "right") {
      setPos(p => ({
        x: forceSide === "left" ? 12 : window.innerWidth - 156 - 12,
        y: p.y,
      }));
    }
  }, [forceSide, freezePos]);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  // Bridge: when the host pushes a new forceEdge value, mirror it into the
  // internal `edge` state so the rest of the component (peek-pose mood,
  // edge-hidden CSS class, chat hide) works unchanged. The host CLEARS by
  // sending null; subsequent clicks on the chibi (onAvatarClick) can also
  // clear `edge` locally — both paths converge on the same state.
  useEffect(() => {
    if (forceEdge !== undefined) setEdge(forceEdge ?? null);
  }, [forceEdge]);
  const [speech, setSpeech] = useState({ visible: true, text: "Hey · clic pour parler" });
  // `hasKey` is the truth-source for "can the chibi actually chat?". It used
  // to be a local `useState(false)` that toggled when the user clicked the
  // "Set API key" badge — purely decorative, never persisted, never matched
  // reality. Now we derive it from the live discovery: if AT LEAST ONE
  // provider responded with at least one model, we have somewhere to talk to.
  const { data: discoveredModels } = useDiscoveredModels();
  const hasKey = discoveredModels.length > 0;
  // The selected model is shared with the main IDE composer via the
  // chat-sync useActiveModel hook (localStorage + Tauri event). Whatever
  // the user picks in either window applies to BOTH from now on.
  const [model] = useActiveModel();
  // Messages are no longer local state — they live in SQLite and stream in
  // from the chat-sync layer. The mascot window READS the active conv from
  // useActiveConv() (the main IDE's ChatSidebar drives the writes); this
  // window now ALSO writes via the new-convo / load-history actions below.
  const [activeConv, setActiveConv] = useActiveConv();
  const { data: msgs } = useMessages(activeConv);
  const [lastMsgCount, setLastMsgCount] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasUnread, setHasUnread] = useState(false); // an LLM reply arrived while tucked / closed
  // Tab switches the .float-history-shell content: "feed" → current convo,
  // "history" → list of past conversations (loaded from SQLite).
  const [tab, setTab] = useState<"feed" | "history">("feed");
  // Past conversations (excluding the active one) — populated lazily when
  // the history tab opens. `histRefresh` bumps to re-pull after delete /
  // new-convo so the list stays in sync without a full hook rewrite.
  const [historyConvs, setHistoryConvs] = useState<{ id: string; title: string; ts: number }[]>([]);
  const [histRefresh, setHistRefresh] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  // Detect "new AI message landed while tucked/closed" so the chibi pops
  // the peek_open expression. Compare the message count against the last
  // observed count — only AI messages added since the user last saw the
  // panel count toward unread.
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

  const side: "left" | "right" =
    forceSide === "left" || forceSide === "right"
      ? forceSide
      : pos.x + 39 > window.innerWidth / 2 ? "right" : "left";

  // ── History tab: load conversations (excluding the active one) ──
  // Only fetch when the history tab is visible and the panel is open. In
  // web mode (no Tauri / no SQLite), db.conversations.list() returns [] —
  // the empty-state message takes over.
  useEffect(() => {
    if (mode !== "full" || tab !== "history") return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await db.conversations.list();
        if (cancelled) return;
        const mapped = rows
          .filter((r: any) => r.id !== activeConv && !r.archived)
          .map((r: any) => ({ id: r.id as string, title: (r.title as string) || "Untitled", ts: (r.updated_at as number) ?? Date.now() }));
        setHistoryConvs(mapped);
      } catch {
        if (!cancelled) setHistoryConvs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, tab, activeConv, histRefresh]);

  // ── Chibi tab actions ──
  // newConvo: only fork a fresh row when the current convo has messages —
  // avoids polluting SQLite with empty rows on rapid "+" clicks. After
  // creating, we flip active to the new id so useMessages reloads to [].
  const newConvo = async () => {
    if (msgs.length === 0) {
      // Already on a fresh empty convo — just switch to the feed tab.
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
  // loadConvo: jump to a past conversation. useMessages picks up the new
  // activeConv and refetches automatically.
  const loadConvo = (id: string) => {
    setActiveConv(id);
    setTab("feed");
    setMode("full");
    bumpInteract();
  };
  // deleteConvo: stops event propagation so the row click doesn't also
  // load the deleted conv. Messages are NOT cascade-deleted (no FK in the
  // schema) — pre-existing limitation, orphaned rows are harmless.
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

  useEffect(() => {
    const onResize = () => {
      setPos(p => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - 156)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - 156)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const send = () => {
    const t = input.trim();
    if (!t || !hasKey) return;
    setInput("");
    setBusy(true);
    setMode("full");
    bumpInteract();
    // sendChatMessage handles both user + AI message persistence in SQLite
    // and broadcasts chat://messages-changed — useMessages above picks up
    // both events and re-renders the history feed. The main IDE's ChatView
    // sees the same updates on its side.
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

  // Mood derivation, manual override + idle ticker are owned by useChibiMood.
  // See src/features/mascot/useChibiMood.ts for the priority table.
  const { mood, cycleMood, bumpInteract } = useChibiMood({
    edge,
    hasUnread,
    busy,
    hasKey,
    pinnedAnno,
    hasMessages: msgs.length > 0,
  });

  const onAvatarMouseDown = (e: React.MouseEvent) => {
    // When the host (mascot window) drives drag at the OS level, bail
    // out — but still preventDefault so the browser doesn't initiate
    // text selection on the SVG/img inside the avatar.
    if (disableInternalDrag) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    movedRef.current = false;
    const startX = e.clientX, startY = e.clientY;
    const startPos = { ...pos };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      const nx = Math.max(-30, Math.min(window.innerWidth - 48, startPos.x + dx));
      const ny = Math.max(-30, Math.min(window.innerHeight - 48, startPos.y + dy));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPos(p => {
        const SNAP = 14;
        const aw = 156;
        const ah = 156;
        const distLeft   = p.x;
        const distRight  = window.innerWidth - (p.x + aw);
        const distTop    = p.y;
        const distBottom = window.innerHeight - (p.y + ah);
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        if (minDist > SNAP) {
          setEdge(null);
          return p;
        }
        if (minDist === distLeft)   { setEdge("left");   return { x: -aw / 2 + 6, y: p.y }; }
        if (minDist === distRight)  { setEdge("right");  return { x: window.innerWidth - aw / 2 - 6, y: p.y }; }
        if (minDist === distTop)    { setEdge("top");    return { x: p.x, y: -ah / 2 + 6 }; }
        if (minDist === distBottom) { setEdge("bottom"); return { x: p.x, y: window.innerHeight - ah / 2 - 6 }; }
        return p;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onAvatarClick = (e: React.MouseEvent) => {
    if (movedRef.current) return;
    if (e.altKey) { cycleMood(); return; }
    if (edge) {
      setEdge(null);
      // In mascot-mode (freezePos), don't auto-reposition the chibi inside
      // the window on un-tuck — the host is responsible for window
      // positioning. Without this guard, clicking the chibi after a screen-
      // edge snap would teleport it 360 px to the side-buffer position.
      if (!freezePos) {
        setPos(p => {
          const aw = 156;
          let nx = p.x, ny = p.y;
          if (edge === "left")   nx = 24;
          if (edge === "right")  nx = window.innerWidth - aw - 24;
          if (edge === "top")    ny = 24;
          if (edge === "bottom") ny = window.innerHeight - aw - 24;
          return { x: nx, y: ny };
        });
      }
      if (mode === "closed") setMode("compact");
      return;
    }
    setMode(m => m === "closed" ? "compact" : "closed");
  };

  const onAvatarDouble = () => {
    setMode(m => m === "full" ? "compact" : "full");
  };

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    setPos(p => ({ x: window.innerWidth - p.x - 156, y: p.y }));
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
          onDoubleClick={onAvatarDouble}
          onContextMenu={onCtx}
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
                    // Cross-window deep-link to Settings → Connections.
                    // 1. Emit a generic navigate event the main window listens to.
                    // 2. Show + unminimize + focus the main window so the user
                    //    actually sees the page that just changed under their
                    //    nose. Each step is independently best-effort: if Tauri
                    //    is somehow unavailable (web mode, missing API) the
                    //    button is just a no-op rather than crashing.
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

// AnnotationLayer — moved to its own module. Re-exported for RootLayout.
export { AnnotationLayer } from "@/features/panels/AnnotationLayer";
// ─── Connections (moved) ────────────────────────────────────
// ConnectionsView + AddProviderModal + ConnCard + types live in their own
// module now. Re-exported so views-code.tsx (its only current consumer)
// keeps working until migrated to the direct path.
export {
  ConnectionsView,
  AddProviderModal,
  ConnCard,
} from "@/features/connections/Connections";
export type { ConnField, ConnCardData } from "@/features/connections/Connections";

export { ProfileView } from "@/features/profile/ProfileView";
