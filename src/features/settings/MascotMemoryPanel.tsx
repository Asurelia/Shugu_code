// Shugu Forge — panneau « Ce que Shugu sait de toi » (socle mémoire mascotte).
// Garde-fou de transparence : tout fait est visible, éditable, supprimable.
// Au socle, les faits sont saisis À LA MAIN ; l'extracteur (lot Persona)
// ajoutera des faits proposés (validated=false) qu'on valide ici.

import React from "react";
import { SettingRow } from "@/features/code/views-code";
import {
  MASCOT_CATEGORIES, CATEGORY_LABELS, type MascotCategory,
  coerceFactInput, subscribeMemoryChanged,
} from "@/features/mascot/mascotMemory";
import {
  useMascotMemory, useUpsertMascotFact,
  useDeleteMascotFact, useValidateMascotFact, MASCOT_MEMORY_KEY,
} from "@/features/mascot/mascotMemoryStore";
import { queryClient } from "@/lib/queryClient";

export function MascotMemoryPanel() {
  const { data: facts = [] } = useMascotMemory();
  const upsert = useUpsertMascotFact();
  const del = useDeleteMascotFact();
  const validate = useValidateMascotFact();

  const [category, setCategory] = React.useState<MascotCategory>("tech");
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Cohérence cross-fenêtre : si une autre fenêtre modifie la mémoire,
  // on réinvalide la query locale (patron broadcast de calibration.ts).
  React.useEffect(() => subscribeMemoryChanged(() => {
    void queryClient.invalidateQueries({ queryKey: MASCOT_MEMORY_KEY });
  }), []);

  const add = () => {
    const r = coerceFactInput({ category, key, value });
    if (r.ok) {
      setError(null);
      upsert.mutate({ ...r.value, source: "user", validated: true });
      setKey(""); setValue("");
    } else {
      // `strict: false` dans ce repo désactive le narrowing de l'union
      // discriminée ; on lit l'erreur via la variante d'échec explicitement.
      setError((r as Extract<typeof r, { ok: false }>).error);
    }
  };

  return (
    <div className="setting-section">
      <h3>Ce que Shugu sait de toi</h3>
      <p className="sub">
        Voici ce que la mascotte retient sur toi pour mieux t'accompagner. Tu peux tout
        corriger ou effacer — rien n'est caché. Les faits que Shugu déduira plus tard
        apparaîtront ici comme « proposés », à valider ou rejeter.
      </p>

      <SettingRow label="Ajouter un fait" desc="Catégorie, sujet, et ce que Shugu doit retenir.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="slider" value={category}
            onChange={(e) => setCategory(e.target.value as MascotCategory)}
            style={{ padding: "4px 6px" }}>
            {MASCOT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <input placeholder="sujet (ex. langage préféré)" value={key}
            onChange={(e) => setKey(e.target.value)}
            style={inputStyle(160)} />
          <input placeholder="valeur (ex. Rust + TS)" value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            style={inputStyle(220)} />
          <button className="lgb lgb-sm" onClick={add} disabled={upsert.isPending}>Ajouter</button>
        </div>
      </SettingRow>
      {error && <div className="sub" style={{ color: "var(--danger, #e88)", marginTop: 4 }}>{error}</div>}

      {facts.length === 0 ? (
        <div className="sub" style={{ marginTop: 12, fontStyle: "italic" }}>
          Shugu ne sait encore rien de toi. Ajoute un premier fait ci-dessus.
        </div>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {facts.map((f) => (
            <div key={f.id} className="setting-row" style={{ alignItems: "center", opacity: f.validated ? 1 : 0.7 }}>
              <div className="info">
                <div className="label">
                  {CATEGORY_LABELS[f.category]} · {f.key}
                  {!f.validated && <span className="chip tertiary" style={{ marginLeft: 6 }}>proposé</span>}
                </div>
                <div className="desc">{f.value}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {!f.validated && (
                  <button className="lgb lgb-sm" onClick={() => validate.mutate(f.id)}>Valider</button>
                )}
                <button className="lgb lgb-sm" onClick={() => del.mutate(f.id)}>Supprimer</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function inputStyle(width: number): React.CSSProperties {
  return {
    width, padding: "4px 8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 4, color: "inherit", fontSize: 12,
  };
}
