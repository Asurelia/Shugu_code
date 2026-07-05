// Shugu Forge — Profile settings view (Settings → Profile).
//
// Fully wired to the local profile store. Display name + email live in the
// SQLite `settings` table (via profileQueries / db.settings) and are shared
// with the titlebar AccountDropdown through the same hook, so the card and this
// page can never disagree. "Default language" is a view onto the real interface
// language setting; "Default model" is the actual active chat model. Nothing
// here is fake, everything persists.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import { ModelPicker } from "@/features/panels/ModelPicker";
import { useActiveModel } from "@/features/chat/chat-sync";
import {
  useProfileFields,
  saveProfileFields,
  initialsOf,
  detectPlatform,
  modelLabel,
} from "@/features/profile/profileQueries";
import {
  loadJSON,
  saveJSON,
  applyInterfaceVars,
  DEFAULT_INTERFACE,
  LS_INTERFACE,
  SegRow,
} from "@/features/settings/settings-extras";

/**
 * Text field that commits on blur / Enter. Shows a "modifié" dot while dirty
 * and a brief "Enregistré" confirmation flash after a successful save
 * (success-feedback). Re-syncs from `value` when the external store loads/changes.
 */
function EditableField({
  label,
  value,
  placeholder,
  type = "text",
  autoComplete,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  onCommit: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // Adopt the external value whenever it changes (initial load, or after our
  // own save invalidates the query). Never clobbers in-progress typing because
  // the store only changes on our own commit.
  useEffect(() => { setDraft(value); }, [value]);

  // Clear the "saved" flash timer if we unmount mid-flash (e.g. the user
  // navigates away right after saving) — avoids a setState on an unmounted node.
  useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current); }, []);

  const dirty = draft !== value;

  const commit = async () => {
    if (draft === value) return;
    await onCommit(draft);
    setSaved(true);
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="conn-field profile-field" style={{ marginBottom: 10 }}>
      <label>
        {label}
        {saved && (
          <span className="field-saved"><Icon name="check" size={10} /> Enregistré</span>
        )}
      </label>
      <div className={"input" + (saved ? " just-saved" : "")}>
        <input
          value={draft}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        {dirty && (
          <span className="field-dirty" title="Modifié — clique ailleurs ou appuie sur Entrée pour enregistrer">●</span>
        )}
      </div>
    </div>
  );
}

/** "Default language" bound to the real interface language (single source).
 *  Mirrors InterfaceSettings' own merge shape so types stay `typeof
 *  DEFAULT_INTERFACE` (no index-signature widening from the loaded blob). */
function LanguageField() {
  const [lang, setLang] = useState<string>(
    () => ({ ...DEFAULT_INTERFACE, ...loadJSON(LS_INTERFACE, {}) }).language,
  );

  const change = (v: string) => {
    setLang(v);
    const next = { ...DEFAULT_INTERFACE, ...loadJSON(LS_INTERFACE, {}), language: v };
    saveJSON(LS_INTERFACE, next);        // localStorage + SQLite mirror
    applyInterfaceVars(next);            // apply live (data-attrs / CSS vars)
  };

  return (
    <SegRow
      value={lang}
      onChange={change}
      options={[
        { v: "en", l: "EN" },
        { v: "fr", l: "FR" },
        { v: "ja", l: "JA" },
        { v: "es", l: "ES" },
        { v: "de", l: "DE" },
      ]}
    />
  );
}

export function ProfileView() {
  const { data: profile } = useProfileFields();
  const [activeModel, setActiveModel] = useActiveModel();

  const name = profile?.name?.trim() ?? "";
  const email = profile?.email?.trim() ?? "";
  const initials = initialsOf(name);
  const platform = detectPlatform();

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Profile</h3>
          <p className="sub">
            Tes informations personnelles. Stockées uniquement localement (SQLite <code>shugu.db</code>),
            jamais transmises sauf appel API explicite.
          </p>
          <div className="profile-card">
            <div className="avatar" aria-hidden={!initials}>
              {initials || <Icon name="agent" size={22} />}
            </div>
            <div className="info">
              <div className={"name" + (name ? "" : " placeholder")}>{name || "Définis ton nom"}</div>
              <div className={"email" + (email ? "" : " placeholder")}>{email || "Ajoute ton e-mail ci-dessous"}</div>
              <div className="meta">
                <span className="chip primary">Édition locale</span>
                <span className="chip">{platform}</span>
                <span className="chip tertiary" title={activeModel || undefined}>{modelLabel(activeModel)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="setting-section">
          <h3>Preferences</h3>
          <EditableField
            label="Display name"
            value={name}
            placeholder="Ton nom"
            autoComplete="name"
            onCommit={(v) => saveProfileFields({ name: v })}
          />
          <EditableField
            label="Email"
            value={email}
            placeholder="toi@domaine.com"
            type="email"
            autoComplete="email"
            onCommit={(v) => saveProfileFields({ email: v })}
          />

          <div className="conn-field profile-field" style={{ marginBottom: 10 }}>
            <label>Default language</label>
            <LanguageField />
          </div>

          <div className="conn-field profile-field">
            <label>Default model</label>
            <div className="profile-model">
              <ModelPicker model={activeModel} onChange={setActiveModel} className="composer-model" />
            </div>
          </div>

          <p className="sub" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="shield" size={12} /> Modifications enregistrées automatiquement, en local.
          </p>
        </div>
      </div>
    </div>
  );
}
