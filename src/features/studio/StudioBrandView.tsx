import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/components";
import { pushToast } from "@/components/toast";
import { useActiveDesignSystem, setActiveDesignSystem } from "@/features/design/activeDesignSystem";
import { fallbackGradient, formatGenerationTime, generationDisplaySrc, copyText } from "@/features/image/imageAssets";
import { useShell } from "@/routes/shell-context";
import { setStudioDraft } from "./studioDraft";
import { setStudioBrandBoard, togglePinnedAsset, useStudioBrandBoard } from "./brandBoard";

type TokenPair = [string, string];

function parseTokens(css: string): { colors: TokenPair[]; others: TokenPair[] } {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  const colors: TokenPair[] = [];
  const others: TokenPair[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const value = m[2].trim().replace(/\s+/g, " ");
    (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^(rgb|rgba|hsl|hsla|oklch|oklab)\(/i.test(value) ? colors : others)
      .push([name, value]);
  }
  return { colors: colors.slice(0, 12), others: others.slice(0, 8) };
}

function assetId(g: any): string {
  return String(g.id);
}

function buildBrief(args: {
  activeName?: string;
  audience: string;
  voice: string;
  notes: string;
  pinned: any[];
}): string {
  const lines = [
    "Créer une interface cohérente avec la direction de marque actuelle.",
    args.activeName ? `Base design system: ${args.activeName}.` : "",
    args.audience.trim() ? `Audience: ${args.audience.trim()}.` : "",
    args.voice.trim() ? `Voix: ${args.voice.trim()}.` : "",
    args.notes.trim() ? `Notes: ${args.notes.trim()}` : "",
    args.pinned.length > 0
      ? `Références visuelles: ${args.pinned.map((g) => `${g.prompt} (${g.model ?? "model inconnu"})`).join(" | ")}`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export function StudioBrandView() {
  const navigate = useNavigate();
  const { generations } = useShell();
  const active = useActiveDesignSystem();
  const board = useStudioBrandBoard();

  const tokens = useMemo(() => parseTokens(active?.tokensCss ?? ""), [active?.tokensCss]);
  const imageAssets = useMemo(
    () => generations.filter((g: any) => (g.kind ?? "image") === "image" && g.resultUrl).slice(0, 18),
    [generations],
  );
  const pinned = useMemo(
    () => board.pinnedAssetIds
      .map((id) => generations.find((g: any) => (g.kind ?? "image") === "image" && assetId(g) === id))
      .filter(Boolean),
    [board.pinnedAssetIds, generations],
  );
  const brief = useMemo(
    () => buildBrief({
      activeName: active?.name,
      audience: board.audience,
      voice: board.voice,
      notes: board.notes,
      pinned,
    }),
    [active?.name, board.audience, board.voice, board.notes, pinned],
  );

  const useBrief = () => {
    setStudioDraft({ brief, step: 1, startingNew: true });
    navigate({ to: "/studio" });
  };

  return (
    <div className="studio-brand scroll">
      <header className="studio-brand-head">
        <div>
          <span className="studio-disco-label">Brand workspace</span>
          <h2>Direction, tokens et assets</h2>
        </div>
        <div className="studio-brand-actions">
          <button className="lgb lgb-sm" onClick={() => navigate({ to: "/image" })}>
            <Icon name="image" size={12} /> Image
          </button>
          <button className="lgb lgb-sm" onClick={() => navigate({ to: "/gallery" })}>
            <Icon name="gallery" size={12} /> Gallery
          </button>
          <button className="lgb lgb-sm" onClick={() => navigate({ to: "/studio/inspiration" })}>
            <Icon name="palette" size={12} /> Inspiration
          </button>
          <button className="lgb lgb-primary lgb-sm" onClick={useBrief} disabled={!brief.trim()}>
            <Icon name="sparkle" size={12} /> Utiliser dans Créer
          </button>
        </div>
      </header>

      <div className="studio-brand-grid">
        <section className="studio-brand-card studio-brand-base">
          <div className="studio-brand-card-head">
            <span>Base active</span>
            {active && (
              <button className="studio-brand-link" onClick={() => setActiveDesignSystem(null)}>
                Retirer
              </button>
            )}
          </div>
          {active ? (
            <>
              <div className="studio-brand-base-name">{active.name}</div>
              <div className="studio-brand-base-id">{active.id}</div>
              {tokens.colors.length > 0 && (
                <div className="studio-brand-swatches">
                  {tokens.colors.map(([name, value]) => (
                    <span key={name} className="studio-brand-swatch" title={`--${name}: ${value}`} style={{ background: value }} />
                  ))}
                </div>
              )}
              <div className="studio-brand-token-list">
                {tokens.others.slice(0, 5).map(([name, value]) => (
                  <div key={name}><span>--{name}</span><b>{value}</b></div>
                ))}
              </div>
            </>
          ) : (
            <button className="studio-brand-empty" onClick={() => navigate({ to: "/studio/inspiration" })}>
              <Icon name="palette" size={18} />
              <span>Choisir une base</span>
            </button>
          )}
        </section>

        <section className="studio-brand-card studio-brand-notes">
          <div className="studio-brand-card-head">
            <span>Direction</span>
            <small>{board.updatedAt ? formatGenerationTime(board.updatedAt) : "non sauvegardé"}</small>
          </div>
          <label>
            Audience
            <input
              value={board.audience}
              onChange={(e) => setStudioBrandBoard({ audience: e.target.value })}
              placeholder="ex. développeurs solo, studio créatif, équipe produit"
            />
          </label>
          <label>
            Voix
            <input
              value={board.voice}
              onChange={(e) => setStudioBrandBoard({ voice: e.target.value })}
              placeholder="ex. calme, précis, complice, premium"
            />
          </label>
          <label>
            Notes
            <textarea
              value={board.notes}
              onChange={(e) => setStudioBrandBoard({ notes: e.target.value })}
              placeholder="Règles visuelles, choses à éviter, rôle de la mascotte, contraintes produit…"
            />
          </label>
        </section>

        <section className="studio-brand-card studio-brand-assets">
          <div className="studio-brand-card-head">
            <span>Références image</span>
            <small>{pinned.length} épinglées</small>
          </div>
          {imageAssets.length === 0 ? (
            <div className="studio-brand-muted">
              <Icon name="image" size={22} />
              <span>Aucun asset image local.</span>
            </div>
          ) : (
            <div className="studio-brand-asset-grid">
              {imageAssets.map((g: any) => {
                const id = assetId(g);
                const src = generationDisplaySrc(g);
                const isPinned = board.pinnedAssetIds.includes(id);
                return (
                  <button
                    key={id}
                    className={"studio-brand-asset" + (isPinned ? " is-pinned" : "")}
                    onClick={() => togglePinnedAsset(id)}
                    title={isPinned ? "Retirer des références" : "Épingler comme référence"}
                  >
                    <span style={{ background: src ? undefined : fallbackGradient(g.hue ?? 250) }}>
                      {src && <img src={src} alt="" />}
                    </span>
                    <b>{isPinned ? "réf" : g.ratio ?? "image"}</b>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="studio-brand-card studio-brand-package">
          <div className="studio-brand-card-head">
            <span>Brief assemblé</span>
            <button
              className="studio-brand-link"
              onClick={() => {
                copyText(brief);
                pushToast("Brief marque copié", "success", 2200);
              }}
            >
              Copier
            </button>
          </div>
          <pre>{brief || "Aucune direction définie."}</pre>
        </section>
      </div>
    </div>
  );
}
