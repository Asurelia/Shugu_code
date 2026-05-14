// Shugu Forge — Interface customization + interactive Shortcuts mapper.
// Ported from settings-extras.jsx.

import { useState, useEffect } from "react";
import { Icon } from "@/components/components";
import { SettingRow, Switch } from "@/features/code/views-code";
import { db } from "@/lib/db";

export const DEFAULT_SHORTCUTS = [
  { group: "General", items: [
    { id: "open-palette",  label: "Open command palette",   keys: ["Cmd", "K"] },
    { id: "toggle-side",   label: "Toggle side panel",      keys: ["Cmd", "B"] },
    { id: "toggle-tweaks", label: "Toggle Tweaks panel",    keys: ["Cmd", ","] },
    { id: "settings",      label: "Open Settings",          keys: ["Cmd", "Shift", ","] },
    { id: "find-global",   label: "Find anywhere",          keys: ["Cmd", "P"] },
  ]},
  { group: "Navigation", items: [
    { id: "view-chat",    label: "Open Chat",               keys: ["Cmd", "Shift", "C"] },
    { id: "view-code",    label: "Open Editor",             keys: ["Cmd", "Shift", "E"] },
    { id: "view-image",   label: "Open Image Studio",       keys: ["Cmd", "Shift", "I"] },
    { id: "view-agents",  label: "Open Agents",             keys: ["Cmd", "Shift", "A"] },
    { id: "view-gallery", label: "Open Gallery",            keys: ["Cmd", "Shift", "G"] },
    { id: "next-tab",     label: "Next tab",                keys: ["Ctrl", "Tab"] },
    { id: "prev-tab",     label: "Previous tab",            keys: ["Ctrl", "Shift", "Tab"] },
  ]},
  { group: "Chat", items: [
    { id: "new-chat",      label: "New conversation",       keys: ["Cmd", "N"] },
    { id: "send-message",  label: "Send message",           keys: ["Enter"] },
    { id: "new-line",      label: "New line",               keys: ["Shift", "Enter"] },
    { id: "focus-float",   label: "Focus floating chat",    keys: ["Cmd", "Shift", "Space"] },
    { id: "switch-model",  label: "Switch model",           keys: ["Cmd", "/"] },
    { id: "regenerate",    label: "Regenerate last reply",  keys: ["Cmd", "R"] },
  ]},
  { group: "Editor", items: [
    { id: "save-file",     label: "Save file",              keys: ["Cmd", "S"] },
    { id: "save-all",      label: "Save all",               keys: ["Cmd", "Alt", "S"] },
    { id: "find",          label: "Find in file",           keys: ["Cmd", "F"] },
    { id: "replace",       label: "Replace",                keys: ["Cmd", "Alt", "F"] },
    { id: "toggle-terminal", label: "Toggle terminal",      keys: ["Cmd", "`"] },
    { id: "toggle-diff",   label: "Toggle diff view",       keys: ["Cmd", "D"] },
    { id: "ai-rewrite",    label: "AI rewrite selection",   keys: ["Cmd", "E"] },
    { id: "ai-explain",    label: "Explain selection",      keys: ["Cmd", "Shift", "E"] },
  ]},
  { group: "Image", items: [
    { id: "img-generate",  label: "Generate",               keys: ["Cmd", "Enter"] },
    { id: "img-variation", label: "Variations of current",  keys: ["Cmd", "Shift", "V"] },
    { id: "img-save",      label: "Save to gallery",        keys: ["Cmd", "S"] },
  ]},
  { group: "Annotations", items: [
    { id: "anno-comment",  label: "Add comment to selection", keys: ["Cmd", "Shift", "M"] },
    { id: "anno-flag",     label: "Add flag",               keys: ["Cmd", "Shift", "F"] },
    { id: "anno-pin",      label: "Pin to floating chat",   keys: ["Cmd", "P"] },
  ]},
  { group: "Conversation list", items: [
    { id: "list-pin",      label: "Pin / unpin",            keys: ["P"] },
    { id: "list-rename",   label: "Rename",                 keys: ["R"] },
    { id: "list-unread",   label: "Toggle unread",          keys: ["U"] },
    { id: "list-duplicate",label: "Duplicate",              keys: ["F"] },
    { id: "list-archive",  label: "Archive",                keys: ["A"] },
    { id: "list-delete",   label: "Delete",                 keys: ["Shift", "D"] },
  ]},
];

export const DEFAULT_INTERFACE = {
  fontScale: 100,
  uiDensity: "comfortable",
  animations: true,
  reducedMotion: false,
  showTooltips: true,
  language: "en",
  glassEnabled: true,
  showLineNumbers: true,
  monoFont: "JetBrains Mono",
  brandName: "Shugu Forge",
  greeting: "Ready. Message Space Agent…",
  emojis: false,
  railLabels: false,
};

const LS_SHORTCUTS = "shugu.shortcuts.v1";
const LS_INTERFACE = "shugu.interface.v1";

/**
 * Settings persistence strategy — localStorage-primary + SQLite mirror.
 *
 * Why: `loadJSON` is used as a `useState` initializer (must be synchronous).
 * Making it async would cascade into ~10 component changes for no UX gain.
 * Instead:
 *   - `loadJSON`  reads localStorage synchronously (web-compatible, instant).
 *   - `saveJSON`  writes localStorage AND fires a fire-and-forget SQLite write.
 * Both stores are local, so this still honours the local-first constraint.
 * SQLite becomes the durable, queryable record; localStorage is the fast cache.
 *
 * TODO: On Tauri startup, call hydrateSettingsFromSqlite() to push SQLite
 * values back into localStorage (for cross-device parity after future sync).
 */
export function loadJSON<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}

export function saveJSON(key: string, val: any) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota / disabled */ }
  // Mirror to SQLite (fire-and-forget; no-op in web mode)
  void db.settings.set(key, JSON.stringify(val));
}

/**
 * Hydrate localStorage from SQLite on startup.
 * Only writes keys ABSENT from localStorage (localStorage-present wins,
 * since it is the live session store). This recovers a fresh session on a
 * machine that has SQLite data but cleared localStorage (e.g. after a
 * browser cache wipe or cross-device sync).
 * No-op in web mode (db.settings.all() returns [] when getDb() is null).
 */
export async function hydrateSettingsFromSqlite(): Promise<void> {
  const rows = await db.settings.all();
  for (const row of rows) {
    if (localStorage.getItem(row.key) === null) {
      try { localStorage.setItem(row.key, row.value); } catch { /* quota / disabled */ }
    }
  }
}

export function applyInterfaceVars(s: typeof DEFAULT_INTERFACE) {
  const r = document.documentElement;
  r.style.setProperty("--ui-font-scale", (s.fontScale / 100).toString());
  r.style.setProperty("--ui-density", s.uiDensity);
  r.style.setProperty("--ui-glass", s.glassEnabled ? "1" : "0");
  if (!s.glassEnabled) r.style.setProperty("--lg-blur", "0px");
  r.dataset.density = s.uiDensity;
  r.dataset.animations = s.animations ? "on" : "off";
  r.dataset.reducedmotion = s.reducedMotion ? "on" : "off";
  r.dataset.glass = s.glassEnabled ? "on" : "off";
}

export function fmtKey(k: string) {
  if (k === "Cmd") return "⌘";
  if (k === "Ctrl") return "⌃";
  if (k === "Alt" || k === "Option") return "⌥";
  if (k === "Shift") return "⇧";
  if (k === "Enter") return "↵";
  if (k === "Tab") return "⇥";
  if (k === "Space") return "␣";
  if (k === "Backspace") return "⌫";
  if (k === "Escape") return "⎋";
  return k;
}

export function KeyCombo({ keys, recording }: { keys: string[]; recording?: boolean }) {
  return (
    <div className={"keycombo" + (recording ? " recording" : "")}>
      {keys.length === 0 && recording && <span className="prompt">Press keys…</span>}
      {keys.map((k, i) => (
        <span key={i} className="kb">{fmtKey(k)}</span>
      ))}
    </div>
  );
}

export function ShortcutsSettings() {
  const [map, setMap] = useState(() => loadJSON(LS_SHORTCUTS, DEFAULT_SHORTCUTS));
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [conflict, setConflict] = useState<any>(null);

  useEffect(() => saveJSON(LS_SHORTCUTS, map), [map]);

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const mods: string[] = [];
      if (e.metaKey)  mods.push("Cmd");
      if (e.ctrlKey)  mods.push("Ctrl");
      if (e.altKey)   mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      let key = e.key;
      if (["Meta", "Control", "Alt", "Shift"].includes(key)) {
        setRecordedKeys(mods);
        return;
      }
      if (key === " ") key = "Space";
      if (key.length === 1) key = key.toUpperCase();
      const combo = [...mods, key];
      setRecordedKeys(combo);
    };
    const onUp = (e: KeyboardEvent) => {
      if (recordedKeys.length > 0 && !["Meta", "Control", "Alt", "Shift"].includes(e.key)) {
        commitRecording();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, recordedKeys]);

  const commitRecording = () => {
    if (recordedKeys.length === 0) { setRecordingId(null); return; }
    let conflictItem: any = null;
    for (const g of map) for (const it of g.items) {
      if (it.id === recordingId) continue;
      if (it.keys.length === recordedKeys.length && it.keys.every((k: string, i: number) => k === recordedKeys[i])) {
        conflictItem = it;
        break;
      }
    }
    if (conflictItem) {
      setConflict({ targetId: recordingId, keys: recordedKeys, conflictWith: conflictItem });
      return;
    }
    apply(recordingId!, recordedKeys);
  };

  const apply = (id: string, keys: string[]) => {
    setMap(m => m.map(g => ({
      ...g,
      items: g.items.map(it => it.id === id ? { ...it, keys } : it),
    })));
    setRecordingId(null);
    setRecordedKeys([]);
    setConflict(null);
  };

  const clearKey = (id: string) => {
    setMap(m => m.map(g => ({
      ...g,
      items: g.items.map(it => it.id === id ? { ...it, keys: [] } : it),
    })));
  };

  const resetAll = () => {
    if (confirm("Reset all shortcuts to defaults?")) {
      setMap(DEFAULT_SHORTCUTS);
    }
  };

  const filtered = map.map(g => ({
    ...g,
    items: g.items.filter(it =>
      !query ||
      it.label.toLowerCase().includes(query.toLowerCase()) ||
      it.keys.join("").toLowerCase().includes(query.toLowerCase())
    )
  })).filter(g => g.items.length);

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Keyboard shortcuts</h3>
          <p className="sub">Click any combo to remap it. Press <span className="kbd">Esc</span> to cancel, <span className="kbd">⌫</span> to clear.</p>
          <div style={{display:"flex", gap:8, alignItems:"center", marginTop:12}}>
            <div style={{flex:1, position:"relative"}}>
              <Icon name="search" size={14} className="search-icon"/>
              <input
                className="lgi"
                style={{paddingLeft:36}}
                placeholder="Filter by action or key…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
            <button className="lgb"><Icon name="download" size={11}/> Export</button>
            <button className="lgb" onClick={resetAll}>Reset all</button>
          </div>
        </div>

        {filtered.map(g => (
          <div key={g.group} className="setting-section">
            <h3>{g.group}</h3>
            <div className="shortcut-list">
              {g.items.map(it => (
                <div key={it.id} className={"shortcut-row" + (recordingId === it.id ? " active" : "")}>
                  <span className="label">{it.label}</span>
                  <button
                    className={"shortcut-trigger" + (recordingId === it.id ? " recording" : "")}
                    onClick={() => {
                      if (recordingId === it.id) {
                        setRecordingId(null);
                        setRecordedKeys([]);
                      } else {
                        setRecordingId(it.id);
                        setRecordedKeys([]);
                      }
                    }}
                    onKeyDown={e => {
                      if (recordingId !== it.id) return;
                      if (e.key === "Escape") { setRecordingId(null); setRecordedKeys([]); }
                      else if (e.key === "Backspace") { clearKey(it.id); setRecordingId(null); setRecordedKeys([]); }
                    }}
                  >
                    {recordingId === it.id
                      ? <KeyCombo keys={recordedKeys} recording/>
                      : <KeyCombo keys={it.keys}/>}
                  </button>
                  <button className="shortcut-clear" title="Clear" onClick={() => clearKey(it.id)}>
                    <Icon name="x" size={11}/>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {conflict && (
        <div className="palette-scrim" onClick={() => setConflict(null)}>
          <div className="palette" style={{width: 420, padding: 0}} onClick={e => e.stopPropagation()}>
            <div style={{padding:"14px 16px", borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
              <div style={{fontFamily:"var(--font-display)", fontWeight:700, fontSize:14, color:"var(--warn)"}}>Conflict</div>
              <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:4, lineHeight:1.5}}>
                <KeyCombo keys={conflict.keys}/> is already used by <strong>{conflict.conflictWith.label}</strong>.
              </div>
            </div>
            <div style={{padding:"12px 16px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", gap:8}}>
              <button className="lgb" onClick={() => { setConflict(null); setRecordingId(null); setRecordedKeys([]); }}>Cancel</button>
              <span style={{flex:1}}></span>
              <button className="lgb" onClick={() => {
                setMap(m => m.map(g => ({
                  ...g,
                  items: g.items.map(it =>
                    it.id === conflict.conflictWith.id ? { ...it, keys: [] } :
                    it.id === conflict.targetId        ? { ...it, keys: conflict.keys } : it
                  ),
                })));
                setConflict(null); setRecordingId(null); setRecordedKeys([]);
              }}>Override</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function InterfaceSettings() {
  const [s, setS] = useState(() => ({ ...DEFAULT_INTERFACE, ...loadJSON(LS_INTERFACE, {}) }));

  useEffect(() => {
    saveJSON(LS_INTERFACE, s);
    applyInterfaceVars(s);
  }, [s]);

  const set = (k: keyof typeof DEFAULT_INTERFACE) => (v: any) => setS(prev => ({ ...prev, [k]: v }));

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Interface</h3>
          <p className="sub">Comportement et densité globale. Les changements sont live.</p>

          <SettingRow label="Density" desc="Air autour des éléments — compact rapproche tout, spacious l'aère.">
            <SegRow value={s.uiDensity} onChange={set("uiDensity")} options={[
              { v: "compact",     l: "Compact" },
              { v: "comfortable", l: "Comfortable" },
              { v: "spacious",    l: "Spacious" },
            ]}/>
          </SettingRow>

          <SettingRow label="Font scale" desc={`${s.fontScale}% — augmente la taille de toute l'UI`}>
            <input className="slider" type="range" min={80} max={140} step={5} value={s.fontScale} onChange={e => set("fontScale")(+e.target.value)} style={{width:160}}/>
          </SettingRow>

          <SettingRow label="Glass effects" desc="Backdrop blur / saturation sur toutes les surfaces.">
            <Switch on={s.glassEnabled} onChange={set("glassEnabled")}/>
          </SettingRow>

          <SettingRow label="Animations" desc="Transitions, halos pulsants, mascotte qui flotte.">
            <Switch on={s.animations} onChange={set("animations")}/>
          </SettingRow>

          <SettingRow label="Reduced motion" desc="Respecte prefers-reduced-motion (désactive translations rapides).">
            <Switch on={s.reducedMotion} onChange={set("reducedMotion")}/>
          </SettingRow>

          <SettingRow label="Tooltips" desc="Affiche les bulles d'aide au survol.">
            <Switch on={s.showTooltips} onChange={set("showTooltips")}/>
          </SettingRow>

          <SettingRow label="Rail labels" desc="Texte à côté de chaque icône de la barre d'activité.">
            <Switch on={s.railLabels} onChange={set("railLabels")}/>
          </SettingRow>

          <SettingRow label="Line numbers in editor" desc="Visible dans CodeMirror.">
            <Switch on={s.showLineNumbers} onChange={set("showLineNumbers")}/>
          </SettingRow>

          <SettingRow label="Use emoji icons" desc="Sur les cartes d'agents et certains badges (sinon fallback monochrome).">
            <Switch on={s.emojis} onChange={set("emojis")}/>
          </SettingRow>
        </div>

        <div className="setting-section">
          <h3>Affichage & langue</h3>
          <SettingRow label="Language" desc="Interface display language.">
            <SegRow value={s.language} onChange={set("language")} options={[
              { v: "en", l: "EN" },
              { v: "fr", l: "FR" },
              { v: "ja", l: "JA" },
              { v: "es", l: "ES" },
              { v: "de", l: "DE" },
            ]}/>
          </SettingRow>

          <SettingRow label="Monospace font" desc="Pour code, terminal, labels.">
            <select className="lgi lgi-select" value={s.monoFont} onChange={e => set("monoFont")(e.target.value)} style={{width:180}}>
              <option>JetBrains Mono</option>
              <option>Fira Code</option>
              <option>IBM Plex Mono</option>
              <option>Cascadia Code</option>
              <option>SF Mono</option>
              <option>ui-monospace</option>
            </select>
          </SettingRow>
        </div>

        <div className="setting-section">
          <h3>Texte & branding</h3>
          <p className="sub">Personnalise les libellés visibles aux utilisateurs (white-label rapide).</p>

          <div className="conn-field" style={{marginBottom:10}}>
            <label>Product name</label>
            <div className="input">
              <input value={s.brandName} onChange={e => set("brandName")(e.target.value)} placeholder="Shugu Forge"/>
            </div>
          </div>

          <div className="conn-field" style={{marginBottom:10}}>
            <label>Float chat greeting</label>
            <div className="input">
              <input value={s.greeting} onChange={e => set("greeting")(e.target.value)} placeholder="Ready. Message Space Agent…"/>
            </div>
          </div>

          <div className="conn-field">
            <label>Empty-state hint</label>
            <div className="input">
              <input defaultValue="No conversation yet — say something." placeholder="Affiché quand la conversation est vide"/>
            </div>
          </div>
        </div>

        <div className="setting-section">
          <h3>Preview</h3>
          <p className="sub">Un échantillon de l'UI à l'échelle actuelle.</p>
          <div style={{display:"flex", gap:10, flexWrap:"wrap", padding:14, background:"rgba(7,7,16,0.5)", border:"1px solid rgba(255,255,255,0.04)", borderRadius:12}}>
            <button className="lgb lgb-primary">{s.brandName}</button>
            <button className="lgb"><Icon name="sparkle" size={12}/> Action</button>
            <span className="chip primary">PRO</span>
            <span className="chip success">connected</span>
            <KeyCombo keys={["Cmd", "K"]}/>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SegRow({ value, onChange, options }: any) {
  return (
    <div className="lg-tabs" style={{padding:3}}>
      {options.map((o: any) => (
        <button key={o.v} className="lg-tab" aria-selected={o.v === value} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}
