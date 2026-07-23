// Shugu Forge — Interface customization + interactive Shortcuts mapper.
// Ported from settings-extras.jsx.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { SettingRow, Switch } from "@/features/code/views-code";
import { db } from "@/lib/db";
import { queryClient } from "@/lib/queryClient";
import { COMMANDS } from "@/lib/commands";
import { useModalFocusTrap } from "@/lib/modalFocus";

// ─── DEFAULT_SHORTCUTS derived from COMMANDS ──────────────────
//
// Single source of truth: COMMANDS array in src/lib/commands.ts.
// This function groups commands by category and maps each to the
// {id, label, keys} shape that ShortcutsSettings expects.
//
// Only commands with a keybinding are included (palette-only commands
// like set-model* are omitted since they have no chord to display).
// Input-local commands (scope: "input") ARE included so they remain
// visible in the shortcuts editor — the dispatcher itself won't fire them.

function buildDefaultShortcuts(): Array<{ group: string; items: Array<{ id: string; label: string; keys: string[] }> }> {
  const groups = new Map<string, Array<{ id: string; label: string; keys: string[] }>>();

  for (const cmd of COMMANDS) {
    if (!cmd.keybinding || cmd.keybinding.length === 0) continue;

    const group = cmd.category;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({
      id: cmd.id,
      label: cmd.title,
      keys: cmd.keybinding,
    });
  }

  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

export const DEFAULT_SHORTCUTS = buildDefaultShortcuts();

export const DEFAULT_INTERFACE = {
  fontScale: 100,
  uiDensity: "comfortable",
  animations: true,
  reducedMotion: false,
  glassEnabled: true,
  monoFont: "JetBrains Mono",
};

const LS_SHORTCUTS = "shugu.shortcuts.v1";
export const LS_INTERFACE = "shugu.interface.v1";

const MONO_STACKS: Record<string, string> = {
  "JetBrains Mono": "'JetBrains Mono', ui-monospace, monospace",
  "Fira Code": "'Fira Code', ui-monospace, monospace",
  "IBM Plex Mono": "'IBM Plex Mono', ui-monospace, monospace",
  "Cascadia Code": "'Cascadia Code', ui-monospace, monospace",
  "SF Mono": "'SF Mono', ui-monospace, monospace",
  "ui-monospace": "ui-monospace, monospace",
};

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
  // Mirror to SQLite (fire-and-forget).
  void db.settings.set(key, JSON.stringify(val));
}

/**
 * Hydrate localStorage from SQLite on startup.
 * Only writes keys ABSENT from localStorage (localStorage-present wins,
 * since it is the live session store). This recovers a fresh session on a
 * machine that has SQLite data but cleared localStorage (e.g. after a
 * browser cache wipe or cross-device sync).
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
  r.style.setProperty("--font-mono", MONO_STACKS[s.monoFont] ?? MONO_STACKS["ui-monospace"]);
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
  const conflictDialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap({
    open: !!conflict,
    containerRef: conflictDialogRef,
    onEscape: () => setConflict(null),
  });

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

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(map, null, 2));
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
            <button className="lgb" onClick={() => void copyJson()}><Icon name="copy" size={11}/> Copier JSON</button>
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
          <div ref={conflictDialogRef} className="palette" role="dialog" aria-modal="true" aria-label="Keyboard shortcut conflict" tabIndex={-1} style={{width: 420, padding: 0}} onClick={e => e.stopPropagation()}>
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

          <AutoEditorContextRow/>
          <ChatToolsRow
            settingKey="chat.readTools"
            label="Le chat peut lire les fichiers"
            desc="Autorise le chat à lire, lister et chercher dans le workspace pour fonder ses réponses (façon Cursor)."
          />
          <ChatToolsRow
            settingKey="chat.writeTools"
            label="Le chat peut modifier les fichiers"
            desc="Autorise le chat à écrire / éditer des fichiers. Chaque tour reste réversible via « Annuler les modifications de ce message »."
          />
          <ChatToolsRow
            settingKey="chat.persona"
            label="Personnalité de Shugu"
            desc="Le chat répond avec la voix de Shugu (chaleureuse, directe, honnête) au lieu du ton neutre du modèle. S'applique à toutes les conversations."
          />
          <CockpitRow />
          <NativeSearchRow />
        </div>

        <div className="setting-section">
          <h3>Typographie</h3>
          <SettingRow label="Police monospace" desc="Appliquée immédiatement au code, au terminal et aux libellés techniques.">
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

      </div>
    </div>
  );
}

/**
 * Toggle « Contexte auto du chat » — pilote `db.settings` `chat.autoEditorContext`.
 *
 * Sémantique alignée sur la lecture côté chat (views-chat.tsx / chat-sync.ts) :
 * ON par défaut = clé absente ou ≠ "false". On stocke donc "false" quand OFF et
 * "true" quand ON. Pattern lecture/écriture copié du toggle `rag.autoCodeContext`
 * (views-code.tsx) : useState + useEffect (db.settings.get) + db.settings.set.
 */
function AutoEditorContextRow() {
  const [on, setOn] = useState(true); // défaut ON

  useEffect(() => {
    let alive = true;
    void db.settings.get("chat.autoEditorContext").then((v) => {
      if (alive) setOn(v !== "false"); // ON sauf valeur explicite "false"
    });
    return () => { alive = false; };
  }, []);

  const change = (v: boolean) => {
    setOn(v);
    void (async () => {
      await db.settings.set("chat.autoEditorContext", v ? "true" : "false");
      // Le composer (views-chat) lit ce réglage via useQuery (staleTime 30s) ;
      // invalider la clé reflète le changement immédiatement (chip + envoi).
      await queryClient.invalidateQueries({ queryKey: ["settings", "chat.autoEditorContext"] });
    })();
  };

  return (
    <SettingRow
      label="Contexte auto du chat"
      desc="Envoie automatiquement le fichier ouvert et la sélection au chat (façon Cursor)."
    >
      <Switch on={on} onChange={change}/>
    </SettingRow>
  );
}

/**
 * Lot A — Task 12 — toggles d'outils fs du chat (`chat.readTools` /
 * `chat.writeTools`).
 *
 * Même sémantique/pattern que AutoEditorContextRow (ci-dessus) : ON par défaut
 * (clé absente ou ≠ "false"), stockage "true"/"false", invalidation de la
 * queryKey ["settings", <clé>] après écriture pour toute UI réactive future.
 * Lu côté envoi par sendChatMessage (chat-sync.ts) via db.settings.get direct ;
 * passé à chat_send en readTools/writeTools (→ read_tools/write_tools côté Rust).
 */
function ChatToolsRow({
  settingKey,
  label,
  desc,
}: {
  settingKey: "chat.readTools" | "chat.writeTools" | "chat.persona";
  label: string;
  desc: string;
}) {
  const [on, setOn] = useState(true); // défaut ON

  useEffect(() => {
    let alive = true;
    void db.settings.get(settingKey).then((v) => {
      if (alive) setOn(v !== "false"); // ON sauf valeur explicite "false"
    });
    return () => { alive = false; };
  }, [settingKey]);

  const change = (v: boolean) => {
    setOn(v);
    void (async () => {
      await db.settings.set(settingKey, v ? "true" : "false");
      await queryClient.invalidateQueries({ queryKey: ["settings", settingKey] });
    })();
  };

  return (
    <SettingRow label={label} desc={desc}>
      <Switch on={on} onChange={change}/>
    </SettingRow>
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

/**
 * Lot Cockpit-1 — toggle du flag `ui.cockpit` (défaut ON depuis le
 * 2026-06-10). Active la disposition « cockpit » (chat + IDE en surfaces) sur
 * la vue Chat ; désactiver ramène l'ancien shell mono-pane.
 */
function CockpitRow() {
  const [on, setOn] = useState(true); // défaut ON (absent = ON)

  useEffect(() => {
    let alive = true;
    void db.settings.get("ui.cockpit").then((v) => {
      if (alive) setOn(v !== "false"); // OFF uniquement si "false"
    });
    return () => { alive = false; };
  }, []);

  const change = (v: boolean) => {
    setOn(v);
    void (async () => {
      await db.settings.set("ui.cockpit", v ? "true" : "false");
      await queryClient.invalidateQueries({ queryKey: ["settings", "ui.cockpit"] });
    })();
  };

  return (
    <SettingRow
      label="Cockpit (chat + IDE)"
      desc="Affiche la vue Chat comme un cockpit : chat à gauche, éditeur/révision en panneau droit redimensionnable. Désactiver ramène la vue chat simple."
    >
      <Switch on={on} onChange={change} />
    </SettingRow>
  );
}

/**
 * Réglage `search.preferNative` (défaut ON). Quand le modèle actif a sa propre
 * recherche web serveur (Claude récent, GPT search-preview), l'agent utilise
 * CET outil natif plutôt que notre recherche client. Désactiver force toujours
 * notre recherche client (Brave/Tavily/DuckDuckGo) — utile pour éviter la
 * facturation de la recherche serveur Anthropic. Lu côté Rust dans le runner.
 */
function NativeSearchRow() {
  const [on, setOn] = useState(true); // défaut ON (absent = ON)

  useEffect(() => {
    let alive = true;
    void db.settings.get("search.preferNative").then((v) => {
      if (alive) setOn(v !== "false");
    });
    return () => { alive = false; };
  }, []);

  const change = (v: boolean) => {
    setOn(v);
    void (async () => {
      await db.settings.set("search.preferNative", v ? "true" : "false");
      await queryClient.invalidateQueries({ queryKey: ["settings", "search.preferNative"] });
    })();
  };

  return (
    <SettingRow
      label="Recherche native du modèle"
      desc="Si le modèle a sa propre recherche web (Claude, GPT search-preview…), l'agent l'utilise directement. Sinon il passe par notre recherche (Brave/Tavily/DuckDuckGo). À noter : la recherche serveur d'Anthropic est facturée par requête."
    >
      <Switch on={on} onChange={change} />
    </SettingRow>
  );
}
