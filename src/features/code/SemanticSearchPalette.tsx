// Shugu Forge — Recherche sémantique (code) — Phase 7 #2.
//
// Palette flottante de recherche sémantique sur l'index `code` (RAG). Tape une
// intention en langage naturel ("où on valide le token JWT"), le backend
// `semantic_search` (lib/vector.ts::semanticSearch) renvoie les chunks de code
// les plus proches ; Enter / clic ouvre le fichier à la bonne ligne dans
// l'éditeur CodeMirror.
//
// Réutilise les classes CSS `.palette-*` de la CommandPalette / QuickOpenPalette
// pour une cohérence visuelle gratuite (même verre, mêmes états, mêmes
// raccourcis). DIFFÉRENCES assumées vs QuickOpenPalette :
//   1. La donnée vient d'un appel ASYNC débounced (~200 ms) au lieu d'un filtre
//      mémoire — on évite de bombarder l'embedding/kNN à chaque frappe.
//   2. Chaque résultat est un VRAI <button> (et non un <div onClick>) : l'audit
//      a11y précédent a flaggé les lignes div-onClick de QuickOpenPalette qui
//      n'héritaient pas du ring :focus-visible global. On corrige ici.
//   3. L'ouverture du fichier passe par useShell() openFile + editorViewRef +
//      le pattern waitForViewOf de FindPanel (attendre le BON view avant de
//      dispatcher la sélection/scroll vers la ligne).

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useShell } from "@/routes/shell-context";
import { semanticSearch, type VecHit } from "@/lib/vector";
import { parseVecHit, buildResultLabel } from "./parseVecHit";
import { Icon } from "@/components/components";
import type { CodeMirrorEditorHandle } from "./CodeMirrorEditor";

const SEARCH_K = 20;
const DEBOUNCE_MS = 200;

/**
 * Attend que CodeMirror remount avec le BON fichier (matching expectedPath) et
 * expose sa view. Identique au helper de FindPanel.tsx:42-58 — extrait ici car
 * les deux panneaux ouvrent un fichier à une ligne précise et ont besoin de la
 * MÊME garantie (le handle peut référencer brièvement l'ancien view pendant le
 * ré-mount async qui suit openFile()). Polling court (30 ms × ~33 ≈ 1 s).
 */
async function waitForViewOf(
  handleRef: React.RefObject<CodeMirrorEditorHandle> | undefined,
  expectedPath: string,
  maxMs = 1000,
): Promise<EditorView | null> {
  if (!handleRef) return null;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const h = handleRef.current;
    if (h && h.getPath() === expectedPath) {
      const view = h.getView();
      if (view) return view;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

export function SemanticSearchPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { openFile, editorViewRef } = useShell();

  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [hits, setHits] = useState<VecHit[]>([]);
  const [loading, setLoading] = useState(false);
  // `searched` distingue "pas encore tapé" de "cherché, 0 résultat" — c'est ce
  // qui pilote l'empty-state pédagogique (index froid) vs l'invite initiale.
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset complet à chaque (ré)ouverture + focus immédiat de l'input.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    setHits([]);
    setLoading(false);
    setSearched(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Recherche débouncée (~200 ms). On annule le timer ET on ignore les
  // réponses obsolètes (cancelled) pour éviter qu'une requête lente écrase une
  // frappe plus récente (race classique du search-as-you-type).
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setHits([]);
      setLoading(false);
      setSearched(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void semanticSearch(query, SEARCH_K)
        .then((r) => {
          if (cancelled) return;
          setHits(r);
          setSearched(true);
        })
        .catch((err) => {
          // semanticSearch dégrade déjà en [] côté Rust quand l'index est
          // vide / le modèle pas prêt ; un throw ici = vraie panne. On log et
          // on retombe sur l'empty-state plutôt que de casser la palette.
          console.warn("[SemanticSearch] semanticSearch failed:", err);
          if (cancelled) return;
          setHits([]);
          setSearched(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, open]);

  // La sélection clavier revient en haut dès que la requête change.
  useEffect(() => {
    setIdx(0);
  }, [q]);

  // Ouvre le hit sélectionné : openFile (read+tab+setActive) puis attend le
  // view du BON fichier avant de positionner le curseur sur la ligne de départ.
  const pick = async (hit: VecHit) => {
    const { path, startLine } = parseVecHit(hit.id);
    onClose();
    await openFile(path);
    const view = await waitForViewOf(editorViewRef, path);
    if (!view) return;
    // Clamp défensif : un index obsolète peut pointer au-delà du doc courant.
    const target = Math.min(Math.max(1, startLine), view.state.doc.lines);
    const lineInfo = view.state.doc.line(target);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      scrollIntoView: true,
    });
    view.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, hits.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[idx];
      if (h) void pick(h);
    }
  };

  // Pré-calcule path + label pour chaque hit (parsing pur, mémoïsé).
  const rows = useMemo(
    () =>
      hits.map((hit) => ({
        hit,
        path: parseVecHit(hit.id).path,
        label: buildResultLabel(hit),
      })),
    [hits],
  );

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-label="Recherche sémantique dans le code"
      >
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Recherche sémantique : décris ce que tu cherches…"
            aria-label="Requête de recherche sémantique"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="palette-list scroll" role="listbox" aria-label="Résultats">
          {/* Indicateur de chargement — texte + pulse ; le pulse respecte
              prefers-reduced-motion (cf. .sem-pulse dans styles.css) et le
              texte reste TOUJOURS présent (la couleur/animation n'est jamais
              le seul signal). */}
          {loading && (
            <div
              role="status"
              aria-live="polite"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "30px 16px",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              <span className="sem-pulse" aria-hidden="true" />
              Recherche sémantique en cours…
            </div>
          )}

          {!loading &&
            rows.map((row, me) => (
              <button
                key={row.hit.id}
                type="button"
                role="option"
                aria-selected={me === idx}
                className={"palette-item" + (me === idx ? " active" : "")}
                // Reset des styles natifs du <button> pour qu'il soit
                // visuellement identique aux lignes .palette-item (qui étaient
                // des <div>), tout en restant un vrai bouton focusable qui
                // hérite du ring :focus-visible global.
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: me === idx ? undefined : "none",
                  border: 0,
                  font: "inherit",
                }}
                onMouseEnter={() => setIdx(me)}
                onClick={() => void pick(row.hit)}
              >
                <div className="ico">
                  <Icon name="code" size={13} />
                </div>
                <div className="body">
                  <div
                    className="name"
                    style={{
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.path}
                  </div>
                  <div className="hint" style={{ color: "var(--on-surface-muted)" }}>
                    {row.label}
                  </div>
                </div>
              </button>
            ))}

          {/* Empty-state pédagogique : index froid OU requête sans résultat.
              semanticSearch renvoie [] dans les deux cas — on oriente vers la
              commande `reindex-code` qui (re)construit l'index sémantique. */}
          {!loading && searched && rows.length === 0 && (
            <div
              style={{
                padding: "26px 18px",
                textAlign: "center",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: "var(--on-surface)", marginBottom: 6 }}>
                Aucun résultat — index pas encore construit ?
              </div>
              <div>
                Lance la commande{" "}
                <span style={{ color: "var(--primary)" }}>« Reindex code »</span>{" "}
                (palette) pour (re)construire l'index sémantique du workspace,
                puis relance ta recherche.
              </div>
            </div>
          )}

          {/* Invite initiale : palette ouverte, rien tapé encore. */}
          {!loading && !searched && (
            <div
              style={{
                padding: "30px 16px",
                textAlign: "center",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              Décris une intention de code à retrouver…
            </div>
          )}
        </div>

        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd" style={{ marginLeft: 2 }}>
              ↓
            </span>{" "}
            naviguer
          </span>
          <span>
            <span className="kbd">↵</span> ouvrir
          </span>
          <span className="spacer"></span>
          <span style={{ color: "var(--primary)" }}>Recherche sémantique</span>
        </div>
      </div>
    </div>
  );
}
