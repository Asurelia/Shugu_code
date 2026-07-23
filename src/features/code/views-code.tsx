// Shugu Forge — Code IDE / Files / Agents / Gallery / Settings dispatcher
// Ported from views-code.jsx. CodeMirror moved to CodeMirrorEditor.tsx (ESM npm).

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "@/components/components";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { Breadcrumbs } from "./Breadcrumbs";
import { OutlinePanel } from "./OutlinePanel";
import { LspStatusIndicator } from "./LspStatusIndicator";
// Items d'activité partagés avec la statusbar globale (agents actifs,
// génération chat, indexation) — même information dans l'éditeur qu'ailleurs.
import { ShellStatusExtras } from "@/components/StatusBar";
import { ShortcutsSettings, InterfaceSettings } from "@/features/settings/settings-extras";
import { ShuguProfileView } from "@/features/settings/ShuguProfileView";
import { CommandRulesSection } from "@/features/settings/CommandRulesSection";
import {
  AboutSettings,
  GeneralSettings,
  ImageSettings,
  ModelSettings,
  PrivacySettings,
} from "@/features/settings/ProductSettings";
import { ConnectionsView, ProfileView } from "@/features/panels/panels";
// Lane OPÉRABILITÉ — Storage / Backup / Diagnostics centers (section « ops »).
import { OpsView } from "@/features/ops/OpsView";
import { db } from "@/lib/db";
import { reindexWorkspace } from "@/features/fs/workspaceIndexer";
import { pushToast } from "@/components/toast";
import { useShell } from "@/routes/shell-context";
import { useGitHead, useGitBlame } from "@/features/git/queries";
import { BranchSwitcherCompact } from "@/features/git/components/BranchSwitcher";
import { GitDiffStats } from "@/features/git/components/GitDiffStats";
// LOT 3 — 2-pane compare view (MergeView). Aliased to avoid collision with
// the existing simple DiffView below (which is used by FilesView for the
// before/after split display in the files browser).
import { DiffView as CompareDiffView } from "./DiffView";
import { InlineEditWidget } from "./ai-edit/InlineEditWidget";
import { useApplyRunner } from "./ai-edit/applyController";
import { fallbackGradient, formatGenerationTime, generationDisplaySrc, copyText as copyImageText } from "@/features/image/imageAssets";
import { togglePinnedAsset, useStudioBrandBoard } from "@/features/studio/brandBoard";
import { invoke } from "@/lib/tauri";
import { queueMediaRetry } from "@/features/image/mediaRetry";

// ─── Code view (editor + tabs + statusbar) ──────────────────
export function CodeView({ activeFile, openFiles, setOpenFiles, setActiveFile, fileContents, setFileContents, editorViewRef, embedded }: any) {
  // embedded?: boolean — passed by SurfaceHost (cockpit editor surface) to strip
  // the statusbar, hide the fixed outline column (replace with floating bubble),
  // and force minimap off. The /code route passes nothing → false → unchanged.
  // LOT 1 — read wordWrap from ShellContext (the source of truth for editor prefs).
  // useShell() is safe here: CodeView is rendered inside the <Outlet> which is
  // inside <ShellContext.Provider> in RootLayout.tsx.
  const { editorPrefs, compareFile, setCompareFile } = useShell();

  // Lot 2 — apply-to-file runner. Watches the pending ApplyRequest (set by
  // RootLayout::applyCodeToFile) and mounts the inline diff once this view's
  // CodeMirror instance is ready for the target file. Lives here because the
  // editor view lifecycle is owned by CodeView (key={activeFile} remount).
  useApplyRunner({ activeFile, editorViewRef, fileContents });

  // LOT 3 — HEAD content for the active file. Used by gitDiffCompartment to
  // render inline diff decorations (added/modified/deleted line markers).
  // Returns null when: file untracked, repo has no commits, not a git repo,
  // or still loading. The prop is passed through to CodeMirrorEditor.
  const gitHeadOriginal = useGitHead(editorPrefs.gitDecorations ? activeFile : null);
  // LOT 3 bis — Per-line blame for the active file. `useGitBlame` is gated by
  // the gitBlame pref AND by `useIsGitRepo()` internally, so it never spams
  // the backend when off or outside a repo. Returns null while loading.
  const blameQuery = useGitBlame(editorPrefs.gitBlame ? activeFile : null);
  const blame = blameQuery.data ?? null;
  const [savedFlash, setSavedFlash] = useState(false);
  // Track previous dirty state for the active file to detect true→false transitions.
  // Reset the ref when the active file changes to avoid cross-tab false positives.
  const prevDirtyRef = useRef<boolean | undefined>(undefined);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lot statusbar (2026-06-10) — position du curseur, écrite IMPÉRATIVEMENT
  // dans le span (pas de setState : un re-render de CodeView par mouvement de
  // curseur réveillerait les freezes WebView2 historiques).
  const cursorSpanRef = useRef<HTMLSpanElement | null>(null);
  const onCursor = useCallback((ln: number, col: number) => {
    if (cursorSpanRef.current) cursorSpanRef.current.textContent = `Ln ${ln}, Col ${col}`;
  }, []);

  // embedded mode — outline bubble state (default closed).
  const [outlineBubbleOpen, setOutlineBubbleOpen] = useState(false);
  const closeOutlineBubble = useCallback(() => setOutlineBubbleOpen(false), []);

  // Esc key closes the outline bubble in embedded mode. Listener is only
  // attached when the bubble is actually open, to avoid a global leak.
  useEffect(() => {
    if (!embedded || !outlineBubbleOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOutlineBubbleOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, outlineBubbleOpen]);

  const activeDirty = fileContents[activeFile]?.dirty;

  useEffect(() => {
    // Reset baseline when switching tabs.
    prevDirtyRef.current = activeDirty;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  useEffect(() => {
    // Detect a true → false transition (a successful save).
    if (prevDirtyRef.current === true && activeDirty === false) {
      setSavedFlash(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500);
    }
    prevDirtyRef.current = activeDirty;
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [activeDirty]);

  const closeTab = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = openFiles.filter((f: string) => f !== path);
    setOpenFiles(nextOpen);
    if (activeFile === path) setActiveFile(nextOpen[nextOpen.length - 1] || null);
  };

  const onChange = (v: string) => {
    if (!activeFile) return;
    setFileContents((c: any) => ({ ...c, [activeFile]: { ...c[activeFile], text: v, dirty: true } }));
  };

  return (
    <div className="ide-shell">
      <div className={"ide-tabs scroll-x" + (embedded ? " ide-tabs--embedded" : "")}>
        {openFiles.map((p: string) => {
          const f = fileContents[p] || {};
          return (
            <button
              key={p}
              className={"ide-tab" + (activeFile === p ? " active" : "") + (f.dirty ? " modified" : "")}
              onClick={() => setActiveFile(p)}
            >
              <span className="ico">{fileIcon(p)}</span>
              <span>{basename(p)}</span>
              {/* Fix 2: dirty tabs show dot by default; on hover (CSS) dot hides and × appears. */}
              {f.dirty && <span className="dot" />}
              <span className="x" onClick={(e) => closeTab(p, e)}>×</span>
            </button>
          );
        })}
      </div>
      <div className="ide-body">
        {/* LOT 2 — Breadcrumbs above editor + OutlinePanel to the right.
            Both poll editorViewRef for view + docVersion via getDocVersion(). */}
        <Breadcrumbs filePath={activeFile} editorHandle={editorViewRef} />
        <div className="ide-main">
          <div className="ide-editor">
            {/* LOT 3 — Compare mode: render 2-pane MergeView when compareFile is set. */}
            {compareFile != null ? (
              <CompareDiffView
                left={compareFile.left}
                right={compareFile.right}
                onClose={() => setCompareFile(null)}
              />
            ) : activeFile && fileContents[activeFile] ? (
              <CodeMirrorEditor
                ref={editorViewRef}
                key={activeFile}
                path={activeFile}
                value={fileContents[activeFile].text}
                onChange={onChange}
                onCursor={onCursor}
                wordWrap={editorPrefs.wordWrap}
                stickyScroll={editorPrefs.stickyScroll}
                minimap={embedded ? false : editorPrefs.minimap}
                gitHeadOriginal={gitHeadOriginal}
                gitDecorations={editorPrefs.gitDecorations}
                blame={blame}
                gitBlameEnabled={editorPrefs.gitBlame}
                tabAutocomplete={editorPrefs.tabAutocomplete}
              />
            ) : (
              <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--on-surface-muted)", fontFamily:"var(--font-mono)", fontSize:12}}>
                No file open. Pick one from the explorer.
              </div>
            )}
            {/* LOT Éditeur⇄AI — widget inline (prompt Cmd+K + barre Accept/Reject).
                Rendu en position:fixed (ancré à la sélection) ; ne rend rien
                quand la session est idle. */}
            <InlineEditWidget />
            {/* embedded mode — outline toggle button + floating bubble card.
                Anchored inside .ide-editor (position:relative), so it overlays
                the editor without touching .ide-main's flex layout.
                Non-embedded: nothing rendered here. */}
            {embedded && (
              <>
                <button
                  className="outline-bubble-toggle"
                  aria-label="Plan / Outline"
                  title="Plan / Outline"
                  onClick={() => setOutlineBubbleOpen(o => !o)}
                  aria-pressed={outlineBubbleOpen}
                >
                  <Icon name="list" size={15} />
                </button>
                {outlineBubbleOpen && (
                  <div className="outline-bubble-card">
                    <OutlinePanel
                      editorHandle={editorViewRef}
                      filePath={activeFile}
                      onNavigate={closeOutlineBubble}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          {/* Fixed outline column — only in non-embedded mode (unchanged path). */}
          {!embedded && <OutlinePanel editorHandle={editorViewRef} filePath={activeFile} />}
        </div>
        {/* Statusbar — hidden in embedded mode (cockpit panel is already chrome-heavy). */}
        {!embedded && (
          <div className="statusbar">
            {/* LOT git-ui: live branch switcher (clickable) replaces the hardcoded "main" label. */}
            <BranchSwitcherCompact />
            {/* LOT git-ui: live diff stats (file counts) replace the hardcoded "+12 −4". */}
            <GitDiffStats />
            <span className="item">UTF-8</span>
            <span className="item">{activeFile ? (fileContents[activeFile]?.lang || "text") : "—"}</span>
            {/* Lot B §4 — statut LSP du langage du fichier actif (vide si pas de LSP). */}
            <LspStatusIndicator activeFile={activeFile} />
            {/* Activité du shell (agents / génération / indexation) — même
                info que la statusbar globale des autres vues. */}
            <ShellStatusExtras />
            <span className="spacer"></span>
            {/* Fix 3: save-state indicator + transient "Saved ✓" flash */}
            {activeFile && (
              savedFlash
                ? <span className="item" style={{color:"var(--success)"}}>Saved ✓</span>
                : <span className="item">{activeDirty ? "● unsaved" : "saved"}</span>
            )}
            {/* Lot statusbar — vraie position du curseur (maj impérative via
                onCursor ; les anciens items « Sandbox · trusted » / « connected »
                étaient des placeholders de maquette, retirés). */}
            <span className="item" ref={cursorSpanRef}>Ln 1, Col 1</span>
          </div>
        )}
      </div>
    </div>
  );
}
export function fileIcon(p: string) {
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "🔷";
  if (p.endsWith(".rs")) return "🦀";
  if (p.endsWith(".css")) return "🎨";
  if (p.endsWith(".json")) return "📦";
  if (p.endsWith(".md")) return "📝";
  return "📄";
}
export function basename(p: string) { return p.split("/").pop() ?? p; }

// ─── Files (browser + preview) ──────────────────────────────
export function FilesView({ activeFile, fileContents }: any) {
  const f = fileContents[activeFile];
  const [showDiff, setShowDiff] = useState(false);

  if (!activeFile || !f) {
    return (
      <div style={{position:"absolute",inset:0, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--on-surface-muted)"}}>
        <div style={{textAlign:"center"}}>
          <Icon name="folder" size={28}/>
          <div style={{marginTop:10, fontFamily:"var(--font-mono)", fontSize:12}}>Pick a file in the explorer.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ide-shell">
      <div className="ide-tabs" style={{justifyContent:"space-between", paddingRight:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10, padding:"0 14px"}}>
          <span className="chip primary">{f.lang || "text"}</span>
          <span style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--on-surface-variant)"}}>{activeFile}</span>
        </div>
        <div style={{display:"flex",alignItems:"center", gap:6}}>
          <button className={"lgb lgb-sm" + (showDiff ? " lgb-primary" : "")} onClick={() => setShowDiff(d => !d)}>
            <Icon name="diff" size={11}/> Diff
          </button>
          <button className="lgb lgb-sm"><Icon name="git" size={11}/> Stage</button>
        </div>
      </div>
      <div className="ide-body">
        {showDiff
          ? <DiffView original={f.original || f.text} modified={f.text}/>
          : <div className="ide-editor"><CodeMirrorEditor key={activeFile} path={activeFile} value={f.text}/></div>}
        <div className="statusbar">
          <span className="item branch">main</span>
          <span className="item">{f.dirty ? "● unsaved" : "saved"}</span>
          {/* Lot B §4 — statut LSP du langage du fichier actif (vide si pas de LSP). */}
          <LspStatusIndicator activeFile={activeFile} />
          <span className="spacer"></span>
          <span className="item">{f.text.split("\n").length} lines</span>
        </div>
      </div>
    </div>
  );
}

export function DiffView({ original, modified }: { original: string; modified: string }) {
  const a = (original || "").split("\n");
  const b = (modified || "").split("\n");
  const max = Math.max(a.length, b.length);
  return (
    <div className="diff-split" style={{flex:1, minHeight:0}}>
      <div className="diff-side">
        <div className="head before"><span>Before · HEAD</span><Icon name="git" size={11}/></div>
        <div className="body scroll" style={{padding:"10px 0", fontFamily:"var(--font-mono)", fontSize:12, lineHeight:1.7, background:"rgba(255,106,138,0.025)"}}>
          {Array.from({length: max}).map((_, i) => {
            const line = a[i] ?? "";
            const diff = (a[i] ?? "") !== (b[i] ?? "");
            return (
              <div key={i} style={{display:"flex", padding:"0 12px", background: diff && line ? "rgba(255,106,138,0.08)" : "transparent"}}>
                <span style={{width:32, color:"var(--on-surface-muted)", textAlign:"right", marginRight:12, flexShrink:0}}>{i+1}</span>
                <span style={{whiteSpace:"pre", color: diff ? "#ffb4c1" : "var(--on-surface-variant)"}}>{line || " "}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="diff-divider"></div>
      <div className="diff-side">
        <div className="head after"><span>After · working tree</span><Icon name="sparkle" size={11}/></div>
        <div className="body scroll" style={{padding:"10px 0", fontFamily:"var(--font-mono)", fontSize:12, lineHeight:1.7, background:"rgba(138,239,199,0.025)"}}>
          {Array.from({length: max}).map((_, i) => {
            const line = b[i] ?? "";
            const diff = (a[i] ?? "") !== (b[i] ?? "");
            return (
              <div key={i} style={{display:"flex", padding:"0 12px", background: diff && line ? "rgba(138,239,199,0.08)" : "transparent"}}>
                <span style={{width:32, color:"var(--on-surface-muted)", textAlign:"right", marginRight:12, flexShrink:0}}>{i+1}</span>
                <span style={{whiteSpace:"pre", color: diff ? "#b6ffb2" : "var(--on-surface-variant)"}}>{line || " "}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Gallery view ───────────────────────────────────────────
export function GalleryView({ generations, setGenerations }: any) {
  const brandBoard = useStudioBrandBoard();
  const navigate = useNavigate();
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const copyPrompt = (prompt: string) => {
    copyImageText(prompt);
    pushToast("Prompt copié", "success", 2200);
  };
  const copyPath = (path?: string | null) => {
    copyImageText(path ?? "");
    pushToast(path ? "Chemin copié" : "Aucun fichier local", path ? "success" : "info", 2200);
  };
  const revealAsset = async (id: string) => {
    setBusyAsset(id);
    try {
      await invoke("media_asset_reveal", { id });
    } catch (error) {
      pushToast(`Impossible de révéler le fichier : ${String(error)}`, "error", 5000);
    } finally {
      setBusyAsset(null);
    }
  };
  const removeAsset = async (generation: any, pinned: boolean) => {
    const id = String(generation.id);
    const confirmed = await confirmDialog(
      generation.resultUrl
        ? "Supprimer cette création de la médiathèque et effacer son fichier local ?"
        : "Supprimer cette création de la médiathèque ?",
      { title: "Supprimer la création", kind: "warning" },
    );
    if (!confirmed) return;
    setBusyAsset(id);
    try {
      await invoke("media_asset_delete", { id, deleteFile: true });
      if (pinned) togglePinnedAsset(id);
      setGenerations((items: any[]) => items.filter((item) => String(item.id) !== id));
      pushToast("Création supprimée", "success", 2400);
    } catch (error) {
      pushToast(`Suppression impossible : ${String(error)}`, "error", 5000);
    } finally {
      setBusyAsset(null);
    }
  };
  const retryAsset = (generation: any) => {
    queueMediaRetry(generation);
    void navigate({ to: "/image" });
  };

  return (
    <div className="gallery-shell scroll">
      <div className="gallery-head">
        <div>
          <div style={{fontFamily:"var(--font-display)", fontSize:14, fontWeight:700}}>Médiathèque · {generations.length} créations</div>
          <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:4}}>Images, vidéos et musiques réellement générées, persistées dans SQLite avec leur fichier local.</div>
        </div>
        <div style={{display:"flex", gap:6}}>
          <span className="chip">grid</span>
          <span className="chip tertiary">{generations.filter((g: any) => g.resultUrl && g.status !== "missing").length} files</span>
        </div>
      </div>
      {generations.length === 0 ? (
        <div className="gallery-empty">
          <Icon name="gallery" size={30} />
          <div>Aucune création pour le moment.</div>
          <span>Les médias produits dans le Studio apparaîtront ici avec leur prompt et leur fichier local.</span>
        </div>
      ) : (
        <div className="gallery-grid">
          {generations.map((g: any) => {
            const id = String(g.id);
            const kind = g.kind ?? "image";
            const pinned = brandBoard.pinnedAssetIds.includes(id);
            const missing = g.status === "missing";
            const src = generationDisplaySrc(g);
            const localPath = typeof g.resultUrl === "string" && (
              /^[A-Za-z]:[\\/]/.test(g.resultUrl) || g.resultUrl.startsWith("/") || g.resultUrl.startsWith("\\\\")
            );
            return (
              <div key={g.id} className="gallery-card" style={{ background: src ? undefined : fallbackGradient(g.hue ?? 250) }}>
                {kind === "image" && (src ? <img className="img-real" src={src} alt={g.prompt} /> : <div className="img"></div>)}
                {kind === "video" && (src
                  ? <video className="img-real" src={src} controls preload="metadata" style={{objectFit:"contain", background:"#050507"}} />
                  : <div className="img-fallback-note">Fichier vidéo absent</div>)}
                {kind === "music" && (
                  <div style={{height:"100%", minHeight:190, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, padding:18}}>
                    <Icon name="sparkle" size={30}/>
                    {src ? <audio src={src} controls preload="metadata" style={{width:"100%"}}/> : <div className="img-fallback-note">Fichier audio absent</div>}
                  </div>
                )}
                <div className="gallery-card-top">
                  <span>{g.model ?? "unknown"}</span>
                  <span>{kind === "image" && pinned ? "brand ref" : `${kind} · ${missing ? "fichier manquant" : (g.status ?? (src ? "done" : "no file"))}`}</span>
                </div>
                <div className="meta">
                  <span style={{flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{g.prompt}</span>
                  <span style={{flexShrink:0}}>{g.ratio}</span>
                </div>
                <div className="gallery-actions">
                  <button className="lgb lgb-sm" onClick={() => copyPrompt(g.prompt)}><Icon name="copy" size={11}/> Prompt</button>
                  <button className="lgb lgb-sm" onClick={() => retryAsset(g)}><Icon name="sparkle" size={11}/> Relancer</button>
                  <button className="lgb lgb-sm" onClick={() => copyPath(g.resultUrl)}><Icon name="download" size={11}/> Path</button>
                  <button
                    className="lgb lgb-sm"
                    disabled={!localPath || missing || busyAsset === id}
                    onClick={() => void revealAsset(id)}
                    title={missing ? "Le fichier local est manquant" : "Afficher dans l’explorateur"}
                  ><Icon name="search" size={11}/> Révéler</button>
                  <button
                    className="lgb lgb-sm"
                    disabled={busyAsset === id}
                    onClick={() => void removeAsset(g, pinned)}
                    style={{ color: "var(--danger)" }}
                  ><Icon name="trash" size={11}/> Supprimer</button>
                  {kind === "image" && (
                    <button
                      className="lgb lgb-sm"
                      disabled={!g.resultUrl}
                      onClick={() => {
                        togglePinnedAsset(id);
                        pushToast(pinned ? "Référence marque retirée" : "Référence marque ajoutée", "success", 2200);
                      }}
                    ><Icon name="image" size={11}/> {pinned ? "Unpin" : "Brand"}</button>
                  )}
                </div>
                <div className="gallery-card-foot">
                  <span>{kind === "image" ? `seed ${g.seed ?? "auto"}` : (g.style ?? kind)}</span>
                  <span>{formatGenerationTime(g.ts)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Settings view dispatcher ───────────────────────────────
export function SettingsView({ section }: { section: string }) {
  if (section === 'models') return <ModelSettings/>;
  if (section === 'image') return <ImageSettings/>;
  if (section === 'editor') return <SettingsEditor/>;
  if (section === 'shortcuts') return <ShortcutsSettings/>;
  if (section === 'interface') return <InterfaceSettings/>;
  if (section === 'mascot') return <ShuguProfileView/>;
  if (section === 'privacy') return <PrivacySettings/>;
  if (section === 'command-rules') return <CommandRulesSection/>;
  if (section === 'ops') return <OpsView/>;
  if (section === 'about') return <AboutSettings/>;
  // Connections + Profile previously fell through to <SettingsGeneral/> here,
  // which is why the sidebar would highlight the entry but the panel showed
  // unrelated content. Each section now resolves to its actual component.
  if (section === 'connections') return <ConnectionsView/>;
  if (section === 'profile') return <ProfileView/>;
  return <GeneralSettings/>;
}

export function SettingRow({ label, desc, children }: any) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="label">{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      data-on={on ? "true" : "false"}
      onClick={() => onChange(!on)}
    />
  );
}

// Suite Lot 4 — toggle auto-RAG (stocké dans db.settings, pas dans editorPrefs
// car c'est une préférence de chat, pas d'éditeur). Self-contained : charge au
// mount, persiste au changement. Absent = ON (défaut depuis le 2026-06-10),
// même convention que chat.readTools — la lecture côté chat-sync est `!== "false"`.
function AutoRagToggle() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let alive = true;
    void db.settings.get("rag.autoCodeContext").then((v) => {
      if (alive) setOn(v !== "false");
    });
    return () => {
      alive = false;
    };
  }, []);
  const toggle = (v: boolean) => {
    setOn(v);
    void db.settings.set("rag.autoCodeContext", v ? "true" : "false");
  };
  return (
    <SettingRow
      label="Auto-contexte code (RAG)"
      desc="Injecte automatiquement dans le chat des extraits de code du workspace sémantiquement proches de ta question (activé par défaut). L'indexation est automatique ; la pertinence dépend du modèle d'embedding. Indépendant des @-mentions explicites."
    >
      <Switch on={on} onChange={toggle} />
    </SettingRow>
  );
}

// Suite Lot 4 — bouton « Réindexer le code » : reconstruit l'index sémantique
// en chunks à la demande (purge + force, contourne le TTL 24h) → rend l'auto-RAG
// vérifiable tout de suite après de gros changements.
function ReindexCodeRow() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    pushToast("Réindexation du code en cours…", "info", 3000);
    try {
      const n = await reindexWorkspace();
      pushToast(`Index code reconstruit : ${n} chunks.`, "success", 5000);
    } catch (err) {
      pushToast("Échec de la réindexation : " + String(err), "error", 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      label="Réindexer le code (RAG)"
      desc="Reconstruit l'index sémantique du workspace en chunks (purge l'ancien index). Utile après de gros changements, ou pour activer l'auto-contexte immédiatement sans attendre le rafraîchissement automatique."
    >
      <button className="lgb lgb-sm" disabled={busy} onClick={run}>
        <Icon name="search" size={11} /> {busy ? "Réindexation…" : "Réindexer"}
      </button>
    </SettingRow>
  );
}

export function SettingsEditor() {
  // LOT 1 — Source of truth: ShellContext editorPrefs (live-synced to the
  // mounted CodeMirrorEditor via the wordWrap prop → useEffect chain).
  // Moved here from InterfaceSettings: word-wrap is an editor preference,
  // not an interface chrome preference. Replaces the previous fake Switch
  // (cleanup-on-replace policy).
  const { editorPrefs, setEditorPref } = useShell();
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Editor</h3>
          <p className="sub">Comportement de l'éditeur de code. Les changements sont immédiats sans rechargement.</p>
          <SettingRow label="Word wrap" desc="Retour à la ligne automatique (Alt+Z). Désactive la minimap.">
            <Switch on={editorPrefs.wordWrap} onChange={(v) => setEditorPref("wordWrap", v)}/>
          </SettingRow>
          <SettingRow label="Sticky scroll" desc="Affiche les entêtes de scope enclosant en haut de l'éditeur lors du scroll.">
            <Switch on={editorPrefs.stickyScroll} onChange={(v) => setEditorPref("stickyScroll", v)}/>
          </SettingRow>
          <SettingRow
            label="Minimap"
            desc={editorPrefs.wordWrap
              ? "Vue miniature du fichier — désactivée tant que Word wrap est actif."
              : "Vue miniature du fichier dans le gutter droit."}
          >
            <Switch on={editorPrefs.minimap} onChange={(v) => setEditorPref("minimap", v)}/>
          </SettingRow>
          <SettingRow label="Format on save" desc="Formate automatiquement le document lors de la sauvegarde (Ctrl+S). Requiert rustfmt, black ou prettier selon le langage.">
            <Switch on={editorPrefs.formatOnSave} onChange={(v) => setEditorPref("formatOnSave", v)}/>
          </SettingRow>
          {/* LOT 3 — Git inline diff decorations */}
          <SettingRow label="Git decorations" desc="Affiche les lignes ajoutées, modifiées et supprimées vs HEAD dans le gutter. Désactivé dans les repos sans commits ou les fichiers non-trackés.">
            <Switch on={editorPrefs.gitDecorations} onChange={(v) => setEditorPref("gitDecorations", v)}/>
          </SettingRow>
          {/* LOT 3 bis — Inline git blame gutter */}
          <SettingRow label="Git blame inline" desc="Affiche l'auteur, le SHA court et l'âge du commit pour chaque ligne dans le gutter. Survol = popup détaillé (SHA complet, auteur, message de commit). Désactivé hors d'un repo git ou pour les fichiers non-trackés.">
            <Switch on={editorPrefs.gitBlame} onChange={(v) => setEditorPref("gitBlame", v)}/>
          </SettingRow>
          {/* Lot 5 — FIM tab autocomplete (ghost text) */}
          <SettingRow label="Tab autocomplete (FIM)" desc="Complétion inline en texte fantôme (Tab pour accepter, Échap pour rejeter). EXPÉRIMENTAL : nécessite un modèle FIM openai-compatible (Qwen2.5-Coder, DeepSeek-Coder, StarCoder…) configuré ; la qualité et la latence dépendent du modèle.">
            <Switch on={editorPrefs.tabAutocomplete} onChange={(v) => setEditorPref("tabAutocomplete", v)}/>
          </SettingRow>
          {/* Suite Lot 4 — auto-RAG code context dans le chat */}
          <AutoRagToggle/>
          {/* Suite Lot 4 — réindexation manuelle */}
          <ReindexCodeRow/>
        </div>
      </div>
    </div>
  );
}
