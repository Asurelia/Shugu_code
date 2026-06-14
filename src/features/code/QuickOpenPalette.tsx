// Shugu Forge — Quick Open (Cmd+P) — lot stubs-palette 2026-06-10.
//
// Sélecteur de fichier flou sur le workspace ouvert : tape quelques lettres,
// Enter ouvre le fichier dans l'éditeur. Réutilise les classes CSS de la
// CommandPalette (.palette-scrim/.palette/.palette-item) pour une cohérence
// visuelle gratuite — même verre, mêmes états, mêmes raccourcis clavier.
//
// La liste vient de fs_list_files (walk plat Rust, sans le cap 5000 du tree,
// borné à 20k) — chargée à CHAQUE ouverture (pas de cache : un fichier créé il
// y a 5 s doit se trouver), filtrée en mémoire par sous-séquence scorée.

import { useEffect, useMemo, useRef, useState } from "react";
import { fsListFiles } from "@/lib/fs";
import { Icon } from "@/components/components";

const MAX_FILES = 20_000;
const MAX_SHOWN = 50;

/**
 * Score de correspondance floue : `q` doit apparaître comme SOUS-SÉQUENCE de
 * `path` (insensible à la casse). Plus le match est compact et proche du nom
 * de fichier, plus le score est haut. -1 = pas de correspondance.
 */
export function fuzzyScore(path: string, q: string): number {
  if (!q) return 0;
  const p = path.toLowerCase();
  const needle = q.toLowerCase();
  let pi = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < needle.length; qi++) {
    const idx = p.indexOf(needle[qi], pi);
    if (idx === -1) return -1;
    if (first === -1) first = idx;
    last = idx;
    pi = idx + 1;
  }
  const spread = last - first + 1; // compacité du match
  const baseStart = p.lastIndexOf("/") + 1;
  let score = 1000 - spread * 4 - first;
  if (first >= baseStart) score += 500; // match dans le nom de fichier
  if (p.endsWith(needle)) score += 200;
  return score;
}

export function QuickOpenPalette({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // (Re)charge la liste plate à chaque ouverture — fraîcheur > micro-latence
  // (le walk Rust d'un projet moyen prend quelques dizaines de ms).
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    setLoading(true);
    let cancelled = false;
    void fsListFiles([], MAX_FILES)
      .then((r) => {
        if (!cancelled) setPaths(r.paths);
      })
      .catch((err) => {
        console.warn("[QuickOpen] fsListFiles failed:", err);
        if (!cancelled) setPaths([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const qq = q.trim();
    if (!qq) return paths.slice(0, MAX_SHOWN);
    const scored: Array<{ path: string; score: number }> = [];
    for (const p of paths) {
      const s = fuzzyScore(p, qq);
      if (s >= 0) scored.push({ path: p, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_SHOWN).map((s) => s.path);
  }, [q, paths]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  const pick = (path: string) => {
    onOpen(path);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[idx];
      if (p) pick(p);
    }
  };

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ouvrir un fichier par son nom…"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list scroll">
          {loading && (
            <div
              style={{
                padding: "30px 16px",
                textAlign: "center",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              Indexation du workspace…
            </div>
          )}
          {!loading &&
            filtered.map((p, me) => {
              const slash = p.lastIndexOf("/");
              const dir = slash >= 0 ? p.slice(0, slash) : "";
              const base = slash >= 0 ? p.slice(slash + 1) : p;
              return (
                <div
                  key={p}
                  className={"palette-item" + (me === idx ? " active" : "")}
                  onMouseEnter={() => setIdx(me)}
                  onClick={() => pick(p)}
                >
                  <div className="ico">
                    <Icon name="file" size={13} />
                  </div>
                  <div className="body">
                    <div className="name">{base}</div>
                    {dir && <div className="hint">{dir}</div>}
                  </div>
                </div>
              );
            })}
          {!loading && filtered.length === 0 && (
            <div
              style={{
                padding: "30px 16px",
                textAlign: "center",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              {paths.length === 0
                ? "Aucun workspace ouvert — ouvre un dossier d'abord."
                : `Aucun fichier pour « ${q} »`}
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
          <span style={{ color: "var(--primary)" }}>Quick Open ⌘P</span>
        </div>
      </div>
    </div>
  );
}
