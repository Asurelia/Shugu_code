// Transparent companion-memory editor. Only validated facts are injected into
// conversational agents; extracted proposals remain inert until approved.

import React from "react";
import {
  MASCOT_CATEGORIES,
  CATEGORY_LABELS,
  type MascotCategory,
  type MascotFact,
  validateFactInput,
  normalizeFactInput,
  subscribeMemoryChanged,
} from "@/features/mascot/mascotMemory";
import {
  useMascotMemory,
  useUpsertMascotFact,
  useDeleteMascotFact,
  useValidateMascotFact,
  MASCOT_MEMORY_KEY,
} from "@/features/mascot/mascotMemoryStore";
import { queryClient } from "@/lib/queryClient";
import "./mascot-memory-panel.css";

export function MascotMemoryPanel() {
  const { data: facts = [] } = useMascotMemory();
  const upsert = useUpsertMascotFact();
  const del = useDeleteMascotFact();
  const validate = useValidateMascotFact();

  const [category, setCategory] = React.useState<MascotCategory>("tech");
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(
    () =>
      subscribeMemoryChanged(() => {
        void queryClient.invalidateQueries({ queryKey: MASCOT_MEMORY_KEY });
      }),
    [],
  );

  const resetForm = () => {
    setKey("");
    setValue("");
    setEditingId(null);
    setError(null);
  };

  const save = () => {
    if (upsert.isPending) return;
    const validationError = validateFactInput({ key, value });
    if (validationError) {
      setError(validationError);
      return;
    }
    const normalized = normalizeFactInput({ category, key, value });
    setError(null);
    upsert.mutate(
      { id: editingId ?? undefined, ...normalized, source: "user" },
      {
        onSuccess: resetForm,
        onError: (mutationError) => setError(String(mutationError)),
      },
    );
  };

  const edit = (fact: MascotFact) => {
    setCategory(fact.category);
    setKey(fact.key);
    setValue(fact.value);
    setEditingId(fact.id);
    setError(null);
  };

  const validatedCount = facts.filter((fact) => fact.validated).length;
  const proposedCount = facts.length - validatedCount;

  return (
    <section className="setting-section memory-panel">
      <div className="memory-panel-head">
        <div>
          <h3>Ce que Shugu sait de toi</h3>
          <p className="sub">
            Seuls les faits validés sont transmis à la mascotte et à l’orchestrateur.
            Une proposition automatique reste inactive jusqu’à ton accord.
          </p>
        </div>
        <div className="memory-stats" aria-label={`${validatedCount} faits actifs`}>
          <span><b>{validatedCount}</b> actifs</span>
          {proposedCount > 0 && <span className="proposed"><b>{proposedCount}</b> proposés</span>}
        </div>
      </div>

      <div className="memory-editor" aria-label={editingId ? "Modifier un fait" : "Ajouter un fait"}>
        <div className="memory-editor-title">
          <span>{editingId ? "Modifier ce souvenir" : "Ajouter un souvenir explicite"}</span>
          {editingId && (
            <button type="button" className="memory-text-action" onClick={resetForm}>
              Annuler
            </button>
          )}
        </div>
        <div className="memory-editor-grid">
          <label>
            <span>Catégorie</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as MascotCategory)}>
              {MASCOT_CATEGORIES.map((item) => (
                <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Sujet</span>
            <input
              placeholder="ex. langage préféré"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <label className="memory-value-field">
            <span>Ce que Shugu doit retenir</span>
            <input
              placeholder="ex. Rust et TypeScript"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
          </label>
          <button
            type="button"
            className="memory-save"
            onClick={save}
            disabled={upsert.isPending}
          >
            {upsert.isPending ? "Enregistrement…" : editingId ? "Enregistrer" : "Ajouter"}
          </button>
        </div>
        {error && <div className="memory-error">{error}</div>}
      </div>

      {facts.length === 0 ? (
        <div className="memory-empty">
          <span className="memory-empty-orbit" aria-hidden="true" />
          <strong>Aucun souvenir de profil</strong>
          <span>Ajoute uniquement ce qui doit réellement influencer les prochaines conversations.</span>
        </div>
      ) : (
        <div className="memory-groups">
          {MASCOT_CATEGORIES.map((group) => {
            const groupFacts = facts.filter((fact) => fact.category === group);
            if (groupFacts.length === 0) return null;
            return (
              <details className="memory-group" key={group} open>
                <summary>
                  <span>{CATEGORY_LABELS[group]}</span>
                  <span className="memory-group-count">{groupFacts.length}</span>
                </summary>
                <div className="memory-facts">
                  {groupFacts.map((fact) => (
                    <article className={`memory-fact${fact.validated ? "" : " is-proposed"}`} key={fact.id}>
                      <div className="memory-fact-copy">
                        <div className="memory-fact-key">
                          {fact.key}
                          {!fact.validated && <span className="memory-proposed-badge">À valider</span>}
                        </div>
                        <div className="memory-fact-value">{fact.value}</div>
                      </div>
                      <div className="memory-fact-actions">
                        {!fact.validated && (
                          <button type="button" className="memory-fact-action approve" onClick={() => validate.mutate(fact.id)}>
                            Valider
                          </button>
                        )}
                        <button type="button" className="memory-fact-action" onClick={() => edit(fact)}>
                          Modifier
                        </button>
                        <button type="button" className="memory-fact-action danger" onClick={() => del.mutate(fact.id)}>
                          Supprimer
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
