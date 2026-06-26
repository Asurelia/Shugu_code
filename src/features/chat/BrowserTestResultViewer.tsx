// Phase 7 #5 — Viewer du résultat de l'outil agent `browser_test`.
//
// Le parsing pur du summary vit dans `./parseBrowserTest` (testé séparément).
// Ici on enrichit ce texte stable avec un badge réussite/échec, la capture en
// évidence et les assertions en liste colorée. Quand aucune capture n'existe,
// `imageUrl` est `undefined` (rendu omis, pas de crash) et la ligne
// « Capture : … » est déjà filtrée par le parser.

import { parseBrowserTestSummary } from "./parseBrowserTest";

function pillFor(passed: boolean | null): { label: string; color: string } {
  if (passed === true) return { label: "Test réussi", color: "var(--success)" };
  if (passed === false) return { label: "Test échoué", color: "var(--danger)" };
  return { label: "Indisponible", color: "var(--warn)" };
}

/**
 * Rend un résultat `browser_test` : badge verdict + capture + assertions + le
 * reste (erreurs/console) en texte. Monté dans la timeline (`ActivityRow`)
 * uniquement quand l'outil est `browser_test`.
 */
export function BrowserTestResultViewer({
  summary,
  imageUrl,
}: {
  summary?: string;
  imageUrl?: string;
}) {
  const p = summary ? parseBrowserTestSummary(summary) : null;
  const pill = pillFor(p?.passed ?? null);

  return (
    <div
      className="browser-test-result"
      style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}
    >
      {summary && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
              color: pill.color,
              border: `1px solid color-mix(in srgb, ${pill.color} 40%, transparent)`,
              background: `color-mix(in srgb, ${pill.color} 12%, transparent)`,
            }}
          >
            {pill.label}
          </span>
          {p?.finalUrl && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--on-surface-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
              }}
              title={p.finalUrl}
            >
              {p.finalUrl}
            </span>
          )}
        </div>
      )}

      {imageUrl && (
        <img
          src={imageUrl}
          alt="Capture de la page testée par browser_test"
          style={{ maxWidth: "100%", borderRadius: 6, display: "block" }}
        />
      )}

      {p && p.assertions.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {p.assertions.map((a, i) => (
            <li
              key={`${a.kind}-${a.target}-${i}`}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                display: "flex",
                gap: 6,
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  color: a.ok ? "var(--success)" : "var(--danger)",
                  fontWeight: 700,
                }}
                aria-hidden="true"
              >
                {a.ok ? "✓" : "✗"}
              </span>
              <span style={{ color: "var(--on-surface-muted)" }}>{a.kind}</span>
              <span>{a.target}</span>
            </li>
          ))}
        </ul>
      )}

      {p && p.rest && <pre className="out">{p.rest}</pre>}
    </div>
  );
}
