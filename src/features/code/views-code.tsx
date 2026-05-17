// Shugu Forge — Code IDE / Files / Agents / Gallery / Settings dispatcher
// Ported from views-code.jsx. CodeMirror moved to CodeMirrorEditor.tsx (ESM npm).

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { ShortcutsSettings, InterfaceSettings } from "@/features/settings/settings-extras";
import { MascotCalibration } from "@/features/settings/MascotCalibration";
import { ConnectionsView, ProfileView } from "@/features/panels/panels";
import { db } from "@/lib/db";
import { queryClient } from "@/lib/queryClient";

// ─── Code view (editor + tabs + statusbar) ──────────────────
export function CodeView({ activeFile, openFiles, setOpenFiles, setActiveFile, fileContents, setFileContents, editorViewRef }: any) {
  const [savedFlash, setSavedFlash] = useState(false);
  // Track previous dirty state for the active file to detect true→false transitions.
  // Reset the ref when the active file changes to avoid cross-tab false positives.
  const prevDirtyRef = useRef<boolean | undefined>(undefined);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <div className="ide-tabs scroll-x">
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
        <div className="ide-editor">
          {activeFile && fileContents[activeFile]
            ? <CodeMirrorEditor ref={editorViewRef} key={activeFile} path={activeFile} value={fileContents[activeFile].text} onChange={onChange} language={fileContents[activeFile].lang}/>
            : <div style={{position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--on-surface-muted)", fontFamily:"var(--font-mono)", fontSize:12}}>No file open. Pick one from the explorer.</div>
          }
        </div>
        <div className="statusbar">
          <span className="item branch">main</span>
          <span className="item git">+12 −4</span>
          <span className="item">UTF-8</span>
          <span className="item">{activeFile ? (fileContents[activeFile]?.lang || "text") : "—"}</span>
          <span className="spacer"></span>
          {/* Fix 3: save-state indicator + transient "Saved ✓" flash */}
          {activeFile && (
            savedFlash
              ? <span className="item" style={{color:"var(--success)"}}>Saved ✓</span>
              : <span className="item">{activeDirty ? "● unsaved" : "saved"}</span>
          )}
          <span className="item"><Icon name="shield" size={11}/> Sandbox · trusted</span>
          <span className="item">Ln 24, Col 18</span>
          <span className="item" style={{color:"var(--tertiary)"}}>● connected</span>
        </div>
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
          : <div className="ide-editor"><CodeMirrorEditor key={activeFile} path={activeFile} value={f.text} language={f.lang}/></div>}
        <div className="statusbar">
          <span className="item branch">main</span>
          <span className="item">{f.dirty ? "● unsaved" : "saved"}</span>
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

// ─── Agents view ────────────────────────────────────────────
export function AgentsView({ agents }: any) {
  return (
    <div className="agent-shell scroll">
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16}}>
        <div>
          <div style={{fontFamily:"var(--font-display)", fontSize:14, fontWeight:700, color:"var(--on-surface)"}}>Active workers · {agents.filter((a: any) => a.status === 'running').length} running</div>
          <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:4}}>Long-running tasks delegated to background agents. They keep working even when you switch views.</div>
        </div>
        <button className="lgb lgb-primary"><Icon name="plus" size={13}/> New agent</button>
      </div>
      <div className="agent-grid">
        {agents.map((a: any) => (
          <div key={a.id} className={"agent-card " + a.status}>
            <div className="head">
              <div className="who">
                <span className="ico" style={{background: a.color}}>{a.icon}</span>
                {a.name}
              </div>
              <span className={"chip " + (a.status === 'running' ? 'tertiary' : a.status === 'done' ? 'success' : 'warn')}>{a.status}</span>
            </div>
            <div className="desc">{a.desc}</div>
            <div className="log">{a.log}</div>
            <div className="foot">
              <span>{a.elapsed}</span>
              <div className="progress"><div className="fill" style={{width: a.progress + "%"}}></div></div>
              <span style={{color: a.status === 'running' ? 'var(--tertiary)' : 'var(--on-surface-muted)'}}>{a.progress}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Gallery view ───────────────────────────────────────────
export function GalleryView({ generations }: any) {
  return (
    <div className="gallery-shell scroll">
      <div className="gallery-head">
        <div>
          <div style={{fontFamily:"var(--font-display)", fontSize:14, fontWeight:700}}>All generations · {generations.length} images</div>
          <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:4}}>Tout est cached localement. Re-clic = ré-injecter dans le prompt.</div>
        </div>
        <div style={{display:"flex", gap:6}}>
          <span className="chip">grid</span>
          <button className="lgb lgb-sm"><Icon name="download" size={12}/> Export all</button>
        </div>
      </div>
      <div className="gallery-grid">
        {generations.map((g: any) => (
          <div key={g.id} className="gallery-card" style={{
            background: `radial-gradient(circle at 30% 30%, hsl(${g.hue} 80% 70%) 0%, transparent 50%), radial-gradient(circle at 70% 70%, hsl(${(g.hue+60)%360} 80% 60%) 0%, transparent 50%), radial-gradient(circle at 60% 30%, hsl(${(g.hue+120)%360} 80% 60%) 0%, transparent 55%), linear-gradient(135deg, #2a1437 0%, #0d0d18 100%)`
          }}>
            <div className="img"></div>
            <div className="meta">
              <span style={{flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{g.prompt}</span>
              <span style={{flexShrink:0}}>{g.ratio}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Settings view dispatcher ───────────────────────────────
export function SettingsView({ section }: { section: string }) {
  if (section === 'models') return <SettingsModels/>;
  if (section === 'image') return <SettingsImage/>;
  if (section === 'editor') return <SettingsEditor/>;
  if (section === 'shortcuts') return <ShortcutsSettings/>;
  if (section === 'interface') return <InterfaceSettings/>;
  if (section === 'mascot') return <MascotCalibration/>;
  if (section === 'privacy') return <SettingsPrivacy/>;
  if (section === 'about') return <SettingsAbout/>;
  // Connections + Profile previously fell through to <SettingsGeneral/> here,
  // which is why the sidebar would highlight the entry but the panel showed
  // unrelated content. Each section now resolves to its actual component.
  if (section === 'connections') return <ConnectionsView/>;
  if (section === 'profile') return <ProfileView/>;
  return <SettingsGeneral/>;
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
  return <div className="switch" data-on={on ? "true" : "false"} onClick={() => onChange(!on)}></div>;
}

export function SettingsGeneral() {
  const [vals, setVals] = useState({ vsync: true, autosave: true, notifs: false, sounds: true });
  const set = (k: string) => (v: boolean) => setVals((s: any) => ({ ...s, [k]: v }));
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>General</h3>
          <p className="sub">Comportement par défaut de l'application.</p>
          <SettingRow label="Autosave" desc="Sauvegarde toutes les 30 secondes."><Switch on={vals.autosave} onChange={set("autosave")}/></SettingRow>
          <SettingRow label="Vsync rendering" desc="Synchronise le rendu avec le refresh moniteur."><Switch on={vals.vsync} onChange={set("vsync")}/></SettingRow>
          <SettingRow label="Notifications système" desc="Bannières OS pour les générations et erreurs."><Switch on={vals.notifs} onChange={set("notifs")}/></SettingRow>
          <SettingRow label="Sons d'interface" desc="Pop discret sur réponse / fin de génération."><Switch on={vals.sounds} onChange={set("sounds")}/></SettingRow>
        </div>
        <div className="setting-section">
          <h3>Apparence</h3>
          <p className="sub">L'apparence vit dans le panneau Tweaks (en bas à droite).</p>
          <SettingRow label="Thème" desc="Celestial Veil · dark uniquement.">
            <span className="chip primary">veil-dark</span>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

export function SettingsModels() {
  const [pick, setPick] = useState("shugu-haiku-4-5");
  const models = [
    { id: "shugu-haiku-4-5", name: "shugu-haiku-4-5", meta: "fast · 8k ctx · default" },
    { id: "shugu-sonnet-5", name: "shugu-sonnet-5", meta: "balanced · 200k ctx" },
    { id: "shugu-opus", name: "shugu-opus", meta: "deep · 200k ctx · slow" },
    { id: "local-qwen", name: "local-qwen-32b", meta: "ollama · 32B · MIT" },
  ];
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Modèles · langage</h3>
          <p className="sub">Choisis le modèle utilisé pour le chat et les agents.</p>
          <div style={{display:"flex", flexDirection:"column", gap:8, marginTop:8}}>
            {models.map(m => (
              <div key={m.id} className={"model-card" + (m.id === pick ? " on" : "")} onClick={() => setPick(m.id)}>
                <div className="mark">{m.id[0].toUpperCase()}</div>
                <div style={{flex:1, minWidth:0}}>
                  <div className="name">{m.name}</div>
                  <div className="meta">{m.meta}</div>
                </div>
                <div className="check">✓</div>
              </div>
            ))}
          </div>
        </div>
        <div className="setting-section">
          <h3>Clés API</h3>
          <p className="sub">Stockées chiffrées dans le keychain OS via Tauri.</p>
          <SettingRow label="Anthropic API Key" desc="Pour les modèles shugu-*"><span className="chip success">connected</span></SettingRow>
          <SettingRow label="Replicate" desc="Pour flux.1 et sdxl"><span className="chip success">connected</span></SettingRow>
          <SettingRow label="Local Ollama" desc="http://localhost:11434"><span className="chip warn">offline</span></SettingRow>
        </div>
      </div>
    </div>
  );
}

export function SettingsImage() {
  const [vals, setVals] = useState({ nsfw: false, watermark: true, upscale: true });
  const set = (k: string) => (v: boolean) => setVals((s: any) => ({ ...s, [k]: v }));
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Image Generation</h3>
          <p className="sub">Defaults pour les nouvelles générations.</p>
          <SettingRow label="Auto-upscale × 2" desc="Lance un pass d'upscale après chaque génération."><Switch on={vals.upscale} onChange={set("upscale")}/></SettingRow>
          <SettingRow label="Watermark caché" desc="Tag invisible C2PA dans le PNG (non-destructif)."><Switch on={vals.watermark} onChange={set("watermark")}/></SettingRow>
          <SettingRow label="Filtres NSFW" desc="Désactiver = travail adulte. Reste local."><Switch on={vals.nsfw} onChange={set("nsfw")}/></SettingRow>
        </div>
      </div>
    </div>
  );
}

export function SettingsEditor() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Editor</h3>
          <p className="sub">CodeMirror 6 — preferences.</p>
          <SettingRow label="Tab size" desc="Espaces ou tab — par fichier."><span className="chip">2 spaces</span></SettingRow>
          <SettingRow label="Word wrap" desc="Soft-wrap des lignes longues."><Switch on={true} onChange={() => {}}/></SettingRow>
          <SettingRow label="Inline AI completions" desc="Suggestions IA en gris pendant la frappe (Tab pour accepter)."><Switch on={true} onChange={() => {}}/></SettingRow>
        </div>
      </div>
    </div>
  );
}

export function SettingsPrivacy() {
  const [clearing, setClearing] = useState(false);

  const handleClearAll = async () => {
    const confirmed = window.confirm(
      "Effacer TOUTES les données ?\n\n" +
      "Conversations, messages, projets, générations, jobs, logs et agents " +
      "seront supprimés définitivement.\n\n" +
      "Vos paramètres (clés API, préférences) seront conservés."
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      await db.clearAll();
      // Invalidate all TanStack queries so the UI reflects the empty state.
      await queryClient.invalidateQueries();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Privacy</h3>
          <p className="sub">Shugu Forge ne transmet rien à un serveur tiers en dehors des appels API explicites.</p>
          <SettingRow label="Telemetry" desc="Crash reports anonymes."><Switch on={false} onChange={() => {}}/></SettingRow>
          <SettingRow label="Conversation history" desc="Stockée localement, chiffrée au repos."><span className="chip success">local · AES-256</span></SettingRow>
          <SettingRow label="Effacer toutes les données" desc="Conversations, générations, projets, caches.">
            <button
              className="lgb"
              style={{color:"var(--danger)", borderColor:"rgba(255,106,138,0.4)"}}
              disabled={clearing}
              onClick={handleClearAll}
            >
              {clearing ? "Effacement…" : "Effacer"}
            </button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

export function SettingsAbout() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>About</h3>
          <p className="sub">Shugu Forge · build de référence.</p>
          <SettingRow label="Version" desc="Tauri 2.1.1 · React 18.3 · CodeMirror 6.26"><span className="chip primary">0.4.0 · veil</span></SettingRow>
          <SettingRow label="Plateforme" desc="macOS 14 · arm64"><span className="chip">darwin-arm64</span></SettingRow>
          <SettingRow label="Repo" desc="Asurelia/Shugu_stream"><span className="kbd">github →</span></SettingRow>
        </div>
      </div>
    </div>
  );
}
