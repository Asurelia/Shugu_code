// Shugu Forge — Inspiration catalogue (open-design design systems).
//
// The "Inspiration" sub-page of the unified Studio (/studio/inspiration).
// A full-width master-detail browser of the vendored open-design design
// systems (nexu-io/open-design, Apache-2.0) — used as a STARTING BASE for
// generation. Systems-only: skills are no longer browsable/selectable here
// because the orchestrator chooses the relevant skill(s) itself during a
// generation (the catalogue is injected into its prompt).
//
// Selecting a system opens a preview pane with three tabs:
//   • Aperçu — components.html in a sandboxed iframe (live component showcase)
//   • Tokens — colour swatches + the rest of the CSS custom properties
//   • Spec   — DESIGN.md rendered (minimal in-house markdown renderer)
//
// "Partir de cette base" stores {id,name,designMd,tokensCss} as the active
// design system (activeDesignSystem.ts) and jumps to the Créer assistant
// (/studio), where it's pre-selected as the brand source.
//
// Rendering choices:
//   - Plain (non-virtualised) filtered list: the catalogue is ≈150 lightweight
//     rows, search-filtered, and matches the repo's other lists (SideFiles,
//     SideGallery). TanStack Virtual is available if this ever grows large.
//   - Markdown + token parsing are tiny in-house functions (no new deps),
//     mirroring src/lib/markdown.ts's "regex over a markdown lib" philosophy.
//     Vendored content is trusted; we still build React nodes (never
//     dangerouslySetInnerHTML).

import { useMemo, useState, createElement, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Icon } from "@/components/components";
import { useDesignSystems, useDesignSystemFiles, type DesignSystemMeta } from "./queries";
import { useActiveDesignSystem, setActiveDesignSystem } from "./activeDesignSystem";
import { setStudioDraft } from "@/features/studio/studioDraft";

// ─── Minimal markdown renderer (no deps, XSS-safe) ────────────

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // `code`, **bold**, *italic*, [label](url) — order matters (code first).
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={k} className="design-md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      // Render links as styled text — no navigation out of the preview.
      nodes.push(<span key={k} className="design-md-link">{mm ? mm[1] : tok}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ source }: { source: string }) {
  const blocks = useMemo<ReactNode[]>(() => {
    const out: ReactNode[] = [];
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let key = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Code fence
      if (/^```/.test(line)) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        out.push(<pre key={key++} className="design-md-pre"><code>{buf.join("\n")}</code></pre>);
        continue;
      }

      // Heading
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const level = Math.min(h[1].length, 6);
        out.push(
          createElement(
            `h${level}`,
            { key: key++, className: `design-md-h design-md-h${level}` },
            renderInline(h[2], `h${key}`),
          ),
        );
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(---|\*\*\*|___)\s*$/.test(line)) { out.push(<hr key={key++} className="design-md-hr"/>); i++; continue; }

      // Blockquote (group consecutive)
      if (/^>\s?/.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push(<blockquote key={key++} className="design-md-quote">{renderInline(buf.join(" "), `q${key}`)}</blockquote>);
        continue;
      }

      // Unordered list
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        out.push(
          <ul key={key++} className="design-md-ul">
            {items.map((it, j) => <li key={j}>{renderInline(it, `u${key}-${j}`)}</li>)}
          </ul>,
        );
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push(
          <ol key={key++} className="design-md-ol">
            {items.map((it, j) => <li key={j}>{renderInline(it, `o${key}-${j}`)}</li>)}
          </ol>,
        );
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) { i++; continue; }

      // Paragraph (group consecutive plain lines)
      const para: string[] = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^(---|\*\*\*|___)\s*$/.test(lines[i])
      ) { para.push(lines[i]); i++; }
      out.push(<p key={key++} className="design-md-p">{renderInline(para.join(" "), `p${key}`)}</p>);
    }
    return out;
  }, [source]);

  return <div className="design-md">{blocks}</div>;
}

// ─── tokens.css parsing (swatches) ────────────────────────────

function isLiteralColor(v: string): boolean {
  if (v.includes("var(")) return false; // can't resolve cross-scope vars to a swatch
  return /^#[0-9a-fA-F]{3,8}$/.test(v) || /^(rgb|rgba|hsl|hsla|oklch|oklab)\(/i.test(v);
}

function parseTokens(css: string): { colors: Array<[string, string]>; others: Array<[string, string]> } {
  // Strip CSS comments first — tokens.css ships a long prose header and inline
  // notes that would otherwise produce phantom "tokens".
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  const colors: Array<[string, string]> = [];
  const others: Array<[string, string]> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const name = m[1].trim();
    const val = m[2].trim().replace(/\s+/g, " ");
    if (seen.has(name)) continue;
    seen.add(name);
    (isLiteralColor(val) ? colors : others).push([name, val]);
  }
  return { colors, others };
}

// ─── Detail: a selected design system ─────────────────────────

type DetailTab = "preview" | "tokens" | "spec";

function SystemDetail({ system }: { system: DesignSystemMeta }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<DetailTab>("preview");
  const files = useDesignSystemFiles(system.id);
  const active = useActiveDesignSystem();
  const isActive = active?.id === system.id;

  const tokens = useMemo(
    () => parseTokens(files.data?.tokensCss ?? ""),
    [files.data?.tokensCss],
  );

  const hasContext =
    !!(files.data && (files.data.designMd.trim() || files.data.tokensCss.trim()));

  // Set this system as the active base, then jump to the Créer assistant where
  // it's pre-selected as the brand source.
  const useAsBase = () => {
    if (!files.data) return;
    setActiveDesignSystem({
      id: system.id,
      name: system.name,
      designMd: files.data.designMd,
      tokensCss: files.data.tokensCss,
    });
    setStudioDraft({ startingNew: true }); // land on the wizard with this base, even if a project exists on disk
    navigate({ to: "/studio" });
  };

  return (
    <div className="design-detail">
      <header className="design-detail-head">
        <div className="design-detail-titles">
          <div className="design-detail-title">{system.name}</div>
          <div className="design-detail-id">{system.id}</div>
        </div>
        <span style={{ flex: 1 }} />
        {isActive ? (
          <span className="design-active-tag"><Icon name="check" size={12} /> Base active</span>
        ) : (
          <button
            className="lgb lgb-primary lgb-sm"
            onClick={useAsBase}
            disabled={files.isLoading || !hasContext}
            title={hasContext ? "Partir de ce système comme base de génération" : "Ce système n'a pas de spec/tokens à transmettre"}
          >
            <Icon name="sparkle" size={12} /> {files.isLoading ? "Chargement…" : "Partir de cette base"}
          </button>
        )}
      </header>

      <div className="design-detail-tabs" role="tablist">
        <button className={"design-dtab" + (tab === "preview" ? " on" : "")} onClick={() => setTab("preview")} role="tab" aria-selected={tab === "preview"}>Aperçu</button>
        <button className={"design-dtab" + (tab === "tokens" ? " on" : "")} onClick={() => setTab("tokens")} role="tab" aria-selected={tab === "tokens"}>Tokens</button>
        <button className={"design-dtab" + (tab === "spec" ? " on" : "")} onClick={() => setTab("spec")} role="tab" aria-selected={tab === "spec"}>Spec</button>
      </div>

      <div className="design-detail-body">
        {tab === "preview" && (
          system.hasComponents ? (
            <iframe
              className="design-preview-frame"
              src={`/design-systems/${system.id}/components.html`}
              title={`Aperçu — ${system.name}`}
              sandbox="allow-scripts"
            />
          ) : (
            <div className="design-empty"><Icon name="image" size={26} /><div>Pas d'aperçu de composants pour ce système.</div></div>
          )
        )}

        {tab === "tokens" && (
          files.isLoading ? (
            <div className="design-empty"><div className="ring" /></div>
          ) : tokens.colors.length === 0 && tokens.others.length === 0 ? (
            <div className="design-empty"><Icon name="sparkle" size={26} /><div>Pas de tokens pour ce système.</div></div>
          ) : (
            <div className="design-tokens scroll">
              {tokens.colors.length > 0 && (
                <>
                  <div className="design-tokens-label">Couleurs</div>
                  <div className="design-swatches">
                    {tokens.colors.map(([name, val]) => (
                      <div key={name} className="design-swatch" title={`${name}: ${val}`}>
                        <span className="design-swatch-chip" style={{ background: val }} />
                        <span className="design-swatch-name">--{name}</span>
                        <span className="design-swatch-val">{val}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {tokens.others.length > 0 && (
                <>
                  <div className="design-tokens-label">Autres tokens</div>
                  <div className="design-token-rows">
                    {tokens.others.map(([name, val]) => (
                      <div key={name} className="design-token-row">
                        <span className="design-token-name">--{name}</span>
                        <span className="design-token-val">{val}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        )}

        {tab === "spec" && (
          files.isLoading ? (
            <div className="design-empty"><div className="ring" /></div>
          ) : files.data?.designMd.trim() ? (
            <div className="design-spec scroll"><Markdown source={files.data.designMd} /></div>
          ) : (
            <div className="design-empty"><Icon name="file" size={26} /><div>Pas de spec (DESIGN.md) pour ce système.</div></div>
          )
        )}
      </div>
    </div>
  );
}

// ─── Inspiration catalogue (master-detail, systems-only) ──────

export function DesignView() {
  const [q, setQ] = useState("");
  const [selSystemId, setSelSystemId] = useState<string | null>(null);

  const systems = useDesignSystems();
  const active = useActiveDesignSystem();

  const query = q.trim().toLowerCase();

  const filteredSystems = useMemo(() => {
    const all = systems.data ?? [];
    if (!query) return all;
    return all.filter((s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query));
  }, [systems.data, query]);

  const selSystem = useMemo(
    () => (systems.data ?? []).find((s) => s.id === selSystemId) ?? null,
    [systems.data, selSystemId],
  );

  return (
    <div className="design-shell">
      <aside className="design-browser">
        <div className="design-browser-head">
          <Icon name="palette" size={14} />
          <span>Systèmes de design</span>
          <span className="design-tab-count">{systems.data?.length ?? 0}</span>
        </div>

        <div className="design-search">
          <Icon name="search" size={14} className="design-search-ico" />
          <input
            className="design-search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filtrer les systèmes…"
            aria-label="Filtrer les systèmes"
          />
          {q && (
            <button className="design-search-clear" onClick={() => setQ("")} aria-label="Effacer la recherche">
              <Icon name="x" size={13} />
            </button>
          )}
        </div>

        <div className="design-list scroll">
          {systems.isLoading && (
            Array.from({ length: 8 }).map((_, i) => <div key={i} className="design-skel" />)
          )}
          {!systems.isLoading && systems.isError && (
            <div className="design-empty design-empty-sm">
              <Icon name="x" size={22} /><div>Catalogue introuvable.</div>
            </div>
          )}
          {!systems.isLoading && !systems.isError && filteredSystems.length === 0 && (
            <div className="design-empty design-empty-sm">
              <Icon name="search" size={22} />
              <div>{q ? `Aucun résultat pour « ${q} »` : "Catalogue vide."}</div>
            </div>
          )}

          {!systems.isLoading && !systems.isError && filteredSystems.map((s) => (
            <button
              key={s.id}
              className={"design-item" + (selSystemId === s.id ? " on" : "")}
              onClick={() => setSelSystemId(s.id)}
            >
              <span className="design-item-name">{s.name}</span>
              <span className="design-item-meta">
                {active?.id === s.id && <span className="design-badge design-badge-active">base</span>}
                {s.hasComponents && <span className="design-badge">aperçu</span>}
                {s.hasTokens && <span className="design-badge">tokens</span>}
                {s.hasSpec && <span className="design-badge">spec</span>}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {selSystem ? (
        <SystemDetail key={selSystem.id} system={selSystem} />
      ) : (
        <div className="design-detail design-detail-empty">
          <Icon name="sparkle" size={30} />
          <div>Sélectionne un système pour le prévisualiser</div>
          <div className="design-detail-hint">Aperçu des composants · palette de tokens · direction de design — puis « Partir de cette base »</div>
        </div>
      )}
    </div>
  );
}
